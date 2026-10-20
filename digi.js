const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const fs = require('fs').promises;
const readline = require('readline');

const DIGI_BASE = 'https://member.digiflazz.com';
const DIGI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// File Storage
const SESSION_FILE = './digi_session.json';
const BLACKLIST_FILE = './blacklist.json';
const SETTINGS_FILE = './settings.json';

// Helper Delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Helper Request dengan mekanisme Auto-Retry saat terkena Rate Limit (HTTP 429)
 */
async function requestWithRetry(requestFn, maxRetries = 3, backoffMs = 3000) {
    let currentBackoff = backoffMs;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await requestFn();
        } catch (err) {
            const status = err.response?.status;
            if (status === 429 && attempt < maxRetries) {
                console.log(`       [??] Rate Limit (429) terdeteksi. Menunggu ${currentBackoff / 1000}s (Percobaan ${attempt}/${maxRetries})...`);
                await sleep(currentBackoff);
                currentBackoff *= 2;
            } else {
                throw err;
            }
        }
    }
}

// ==========================================
// AUTO GENERATE KODE PRODUK
// ==========================================
function generateProductCode(productName) {
    const cleanName = String(productName || '').replace(/\./g, '').replace(/[^a-zA-Z0-9\s]/g, ' ');
    const words = cleanName.trim().split(/\s+/);
    let code = '';
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (word.length > 0) {
            if (/^\d+$/.test(word)) {
                code += word;
            } else if (i === 0) {
                code += word.substring(0, 2).toUpperCase();
            } else {
                code += word[0].toUpperCase();
            }
        }
    }
    return code;
}

/**
 * Resolve KODE PRODUK (field "code", bukan seller_sku_code) berdasarkan mode:
 * - 'all'  : auto generate kode produk untuk semua produk (overwrite)
 * - 'fill' : hanya isi kode yang kosong (kode lama dipertahankan)
 * - 'off'  : jangan bikin kode baru
 */
function resolveSkuCode(prod, mode) {
    const existing = prod.code;
    const generated = generateProductCode(prod.product || prod.name || '');
    if (mode === 'all') return generated || existing || '';
    if (mode === 'fill') return existing || generated || '';
    return existing || '';
}

/**
 * Parse jumlah pemberi rating dari format Digiflazz ("60+", "10", "1rb+") menjadi angka.
 * "60+" -> 60, "10" -> 10, "1rb+" -> 1000, kosong/null -> 0
 */
function parseRatingQty(ratingQty) {
    if (typeof ratingQty === 'number') return ratingQty;
    const str = String(ratingQty || '').trim().toLowerCase();
    if (!str) return 0;
    if (str.endsWith('rb') || str.endsWith('rb+') || str.endsWith('k') || str.endsWith('k+')) {
        const num = parseFloat(str.replace(/rb\+?$|k\+?$/, ''));
        return Math.round((isNaN(num) ? 0 : num) * 1000);
    }
    const num = parseFloat(str.replace('+', ''));
    return isNaN(num) ? 0 : num;
}

function askCodeMode() {
    console.log("\n--- GENERATE KODE PRODUK ---");
    console.log("1. Auto generate kode produk (semua produk dibuat ulang dari nama produk)");
    console.log("2. Hanya isi kode yang kosong (kode lama dipertahankan)");
    console.log("3. Jangan bikin kode baru");
    const choice = askQuestion('> Pilih (1/2/3) [default: 3] : ');
    return choice;
}

function parseCodeMode(choice) {
    if (String(choice).trim() === '1') return 'all';
    if (String(choice).trim() === '2') return 'fill';
    return 'off';
}

function codeModeText(mode) {
    if (mode === 'all') return 'Auto Generate (Semua Produk)';
    if (mode === 'fill') return 'Hanya Kode Kosong';
    return 'Tidak (Jangan Bikin Baru)';
}

// ==========================================
// TERMINAL UI & PROMPT HELPER
// ==========================================
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

const askPassword = (query) => {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        if (stdin.setRawMode) stdin.setRawMode(true);
        stdin.resume();
        process.stdout.write(query);

        let password = '';
        const onData = (chunk) => {
            const str = chunk.toString('utf8');
            for (let i = 0; i < str.length; i++) {
                const char = str[i];
                if (char === '\n' || char === '\r' || char === '\u0004') {
                    if (stdin.setRawMode) stdin.setRawMode(wasRaw || false);
                    stdin.removeListener('data', onData);
                    process.stdout.write('\n');
                    resolve(password);
                    return;
                } else if (char === '\u0003') {
                    process.exit(0);
                } else if (char === '\b' || char === '\x7f') {
                    if (password.length > 0) {
                        password = password.slice(0, -1);
                        process.stdout.write('\b \b');
                    }
                } else {
                    password += char;
                    process.stdout.write('*');
                }
            }
        };
        stdin.on('data', onData);
    });
};

function displayBanner() {
    console.clear();
    console.log(`
¦¦¦¦¦¦+ ¦¦+ ¦¦¦¦¦¦+ ¦¦+¦¦¦¦¦¦¦+¦¦+      ¦¦¦¦¦+ ¦¦¦¦¦¦¦+¦¦¦¦¦¦¦+
¦¦+--¦¦+¦¦¦¦¦+----+ ¦¦¦¦¦+----+¦¦¦     ¦¦+--¦¦++--¦¦¦+++--¦¦¦++
¦¦¦  ¦¦¦¦¦¦¦¦¦  ¦¦¦+¦¦¦¦¦¦¦¦+  ¦¦¦     ¦¦¦¦¦¦¦¦  ¦¦¦++   ¦¦¦++
¦¦¦  ¦¦¦¦¦¦¦¦¦   ¦¦¦¦¦¦¦¦+--+  ¦¦¦     ¦¦+--¦¦¦ ¦¦¦++   ¦¦¦++
¦¦¦¦¦¦++¦¦¦+¦¦¦¦¦¦++¦¦¦¦¦¦     ¦¦¦¦¦¦¦+¦¦¦  ¦¦¦¦¦¦¦¦¦¦+¦¦¦¦¦¦¦+
+-----+ +-+ +-----+ +-++-+     +------++-+  +-++------++------+
                    TOOLS BY ANDIKAPUTRA
---------------------------------------------------------------`);
}

// ==========================================
// DATA HANDLERS
// ==========================================
async function loadFile(filePath, defaultData) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch {
        return defaultData;
    }
}

async function loadSession() {
    try {
        const data = await fs.readFile(SESSION_FILE, 'utf8');
        return data ? data : null;
    } catch {
        return null;
    }
}

async function saveSession(cookieJson) {
    await fs.writeFile(SESSION_FILE, cookieJson, 'utf8');
}

async function loadBlacklist() {
    return await loadFile(BLACKLIST_FILE, []);
}

async function saveBlacklist(list) {
    await fs.writeFile(BLACKLIST_FILE, JSON.stringify(list, null, 2), 'utf8');
}

async function loadSettings() {
    const defaultSet = {
        autoUpdate: false,
        time: '00:00',
        minRating: 4.0,
        minRatingQty: 0,
        sortPrice: 'termurah',
        targetType: 'gangguan',
        useMaxPrice: true,
        autoCodeMode: 'off'
    };
    return await loadFile(SETTINGS_FILE, defaultSet);
}

async function saveSettings(settings) {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

// ==========================================
// CORE SYSTEM (Axios)
// ==========================================
function createClient(cookieJson) {
    let jar;
    try {
        jar = cookieJson ? CookieJar.fromJSON(JSON.parse(cookieJson)) : new CookieJar();
    } catch {
        jar = new CookieJar();
    }
    const client = wrapper(axios.create({ jar, withCredentials: true }));
    return { client, jar };
}

async function getCsrf(jar) {
    const cookies = await jar.getCookies(DIGI_BASE);
    const xsrf = cookies.find(c => c.key === 'XSRF-TOKEN');
    return xsrf ? decodeURIComponent(xsrf.value) : '';
}

function digiHeaders(csrfToken, referer) {
    return {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': DIGI_UA,
        'Origin': DIGI_BASE,
        'Referer': referer || `${DIGI_BASE}/buyer-area`,
        'X-XSRF-TOKEN': csrfToken
    };
}

/**
 * Merangkum detail error dari response server (status + body Laravel)
 * agar penyebab 400/422 langsung terlihat di terminal.
 */
function errorDetail(err) {
    const status = err.response?.status;
    const data = err.response?.data;
    let body = '';
    if (data) {
        if (typeof data === 'string') {
            body = data.slice(0, 300);
        } else {
            const errors = data.errors
                ? ' | errors: ' + JSON.stringify(data.errors)
                : '';
            body = `${data.message || ''}${errors}`;
        }
    }
    return `[HTTP ${status || '-'}] ${body || err.message}`;
}

function isSessionExpired(err) {
    const status = err.response?.status;
    return status === 419 || status === 401;
}

// ==========================================
// BACKGROUND SCHEDULER
// ==========================================
let hasRunToday = false;

async function startDaemon() {
    setInterval(async () => {
        const settings = await loadSettings();
        if (!settings.autoUpdate) return;

        const nowWIB = new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" });
        const dateWIB = new Date(nowWIB);
        const hours = dateWIB.getHours().toString().padStart(2, '0');
        const minutes = dateWIB.getMinutes().toString().padStart(2, '0');
        const currentTime = `${hours}:${minutes}`;

        if (currentTime !== settings.time) {
            hasRunToday = false;
        }

        if (currentTime === settings.time && !hasRunToday) {
            hasRunToday = true;
            console.log(`\n\n[?? SCHEDULER] Pukul ${currentTime} WIB. Memulai Auto Update Seller...`);
            await executeAutoUpdateProcess();
            console.log(`\n[?? SCHEDULER] Selesai. Tekan [ENTER] untuk menyegarkan menu.`);
        }
    }, 60000);
}

// ==========================================
// LOGIN FLOW
// ==========================================
async function login() {
    displayBanner();
    console.log("Silakan masukkan kredensial Digiflazz Anda:\n");

    const username = await askQuestion('> email : ');
    const password = await askPassword('> password : ');
    console.log("\n[~] Memproses login...");

    try {
        const { client, jar } = createClient(null);
        await client.get(`${DIGI_BASE}/login`, { headers: { 'User-Agent': DIGI_UA } });
        const csrf = await getCsrf(jar);

        await client.post(`${DIGI_BASE}/login`, { username, password, remember: false }, {
            headers: digiHeaders(csrf, `${DIGI_BASE}/login`)
        });

        await saveSession(JSON.stringify(jar.toJSON()));
        console.log("[?] Kredensial benar. Membutuhkan verifikasi 2FA.");
        await verify2fa();
    } catch (err) {
        if (err.response?.status === 422) console.log("[X] Username atau password salah!");
        else console.log("[X] Gagal login:", err.message);
        process.exit(1);
    }
}

async function verify2fa() {
    const code = await askQuestion('> masukkan kode 2FA : ');
    console.log("[~] Memverifikasi kode 2FA...");

    try {
        const sessionData = await loadSession();
        const { client, jar } = createClient(sessionData);
        const csrf = await getCsrf(jar);

        await client.post(`${DIGI_BASE}/2fa`, { one_time_password: code }, { headers: digiHeaders(csrf, `${DIGI_BASE}/2fa`) });
        await client.get(`${DIGI_BASE}/buyer-area`, { headers: { 'Accept': 'text/html', 'User-Agent': DIGI_UA, 'Referer': `${DIGI_BASE}/2fa` } });

        await saveSession(JSON.stringify(jar.toJSON()));
        const newCsrf = await getCsrf(jar);
        const profileRes = await client.get(`${DIGI_BASE}/api/v1/buyer/account/profile`, { headers: digiHeaders(newCsrf) });

        displayBanner();
        console.log(`\n[?] LOGIN BERHASIL! Selamat datang, ${profileRes.data.data.user?.name}\n`);
        await mainMenu();
    } catch (err) {
        console.log("[X] Kode 2FA salah atau expired.");
        process.exit(1);
    }
}

// ==========================================
// MAIN MENU
// ==========================================
async function mainMenu() {
    while (true) {
        const settings = await loadSettings();
        const statusAuto = settings.autoUpdate ? `\x1b[32mON (${settings.time} WIB)\x1b[0m` : `\x1b[31mOFF\x1b[0m`;

        console.log("\n=== MENU UTAMA ===");
        console.log("1. Blacklist Seller");
        console.log("2. Pick Seller");
        console.log("3. Pilih Produk [oncomming]");
        console.log(`4. Auto Update Seller [Status: ${statusAuto}]`);
        console.log("5. Keluar");
        console.log("\nCredit :\nandikaputra\nodzreshop\n");

        const choice = await askQuestion('> Pilih menu (1/2/3/4/5) : ');

        if (choice === '1') await manageBlacklist();
        else if (choice === '2') await startWizard();
        else if (choice === '3') console.log("\n[!] Fitur 'Pilih Produk' masih dalam tahap pengembangan (Oncomming).");
        else if (choice === '4') await manageAutoUpdate();
        else if (choice === '5') { console.log("\nTerima kasih, sampai jumpa!"); process.exit(0); }
        else console.log("\n[!] Pilihan tidak valid.");
    }
}

// ==========================================
// AUTO UPDATE SELLER MANAGEMENT
// ==========================================
async function manageAutoUpdate() {
    while (true) {
        const settings = await loadSettings();
        const targetText = settings.targetType === 'gangguan' ? 'Hanya Produk Stok 0 / Gangguan' : 'Semua Produk';
        const sortText = settings.sortPrice === 'termurah' ? 'Termurah' : (settings.sortPrice === 'termahal' ? 'Termahal' : 'Random (Acak)');
        const maxPriceText = settings.useMaxPrice ? 'Sama dengan Modal Seller' : 'Rp 0 (Tanpa Limit)';

        console.log("\n=== PENGATURAN AUTO UPDATE SELLER ===");
        console.log(`1. Status Auto Update : ${settings.autoUpdate ? '\x1b[32mAKTIF (ON)\x1b[0m' : '\x1b[31mNON-AKTIF (OFF)\x1b[0m'}`);
        console.log(`2. Jadwal Eksekusi    : Jam ${settings.time} WIB`);
        console.log(`3. Kriteria Seller    : Min Rating ${settings.minRating} | Min Pemberi Rating ${settings.minRatingQty ?? 0} | Wajib Multi: Ya | Urutan: ${sortText}`);
        console.log(`4. Target Produk      : ${targetText}`);
        console.log(`5. Set Max Price      : ${maxPriceText}`);
        console.log(`6. Generate Kode Produk : ${codeModeText(settings.autoCodeMode)}`);
        console.log("------------------------------------------------");
        console.log("7. Jalankan Auto Update SEKARANG (Manual)");
        console.log("8. Kembali ke Menu Utama");

        const choice = await askQuestion('> Pilih opsi (1-8) : ');

        if (choice === '1') {
            settings.autoUpdate = !settings.autoUpdate;
            await saveSettings(settings);
            console.log(`\n[?] Status Auto Update diubah menjadi: ${settings.autoUpdate ? 'ON' : 'OFF'}`);
        }
        else if (choice === '2') {
            const newTime = await askQuestion('> Masukkan jadwal jam (Format HH:MM, misal 00:00) : ');
            if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(newTime.trim())) {
                settings.time = newTime.trim();
                await saveSettings(settings);
                console.log(`\n[?] Jadwal eksekusi berhasil diatur ke jam ${settings.time} WIB.`);
            } else {
                console.log("\n[!] Format jam tidak valid. Gunakan HH:MM (24 jam).");
            }
        }
        else if (choice === '3') {
            console.log("\n--- ATUR TIPE / KRITERIA SELLER ---");
            const minRt = await askQuestion(`> Minimal Rating (0-5) [sekarang: ${settings.minRating}] : `);
            if (minRt.trim() !== '' && !isNaN(parseFloat(minRt))) {
                settings.minRating = parseFloat(minRt);
            }

            const minRq = await askQuestion(`> Minimal Pemberi Rating (jumlah orang, misal 10) [sekarang: ${settings.minRatingQty ?? 0}] : `);
            if (minRq.trim() !== '' && !isNaN(parseFloat(minRq))) {
                settings.minRatingQty = parseFloat(minRq);
            }

            console.log("\nPilih Urutan / Tipe Pemilihan Seller:");
            console.log("1. Termurah\n2. Termahal\n3. Random / Acak");
            const sortChoice = await askQuestion('> Pilih (1/2/3) : ');
            if (sortChoice === '1') settings.sortPrice = 'termurah';
            else if (sortChoice === '2') settings.sortPrice = 'termahal';
            else if (sortChoice === '3') settings.sortPrice = 'random';

            await saveSettings(settings);
            console.log(`\n[?] Kriteria seller berhasil diperbarui.`);
        }
        else if (choice === '4') {
            console.log("\n--- ATUR TARGET PRODUK ---");
            console.log("1. Hanya Produk Stok 0 / Gangguan\n2. Semua Produk Tanpa Terkecuali");
            const targetChoice = await askQuestion('> Pilih target (1/2) : ');
            if (targetChoice === '1') settings.targetType = 'gangguan';
            else if (targetChoice === '2') settings.targetType = 'semua';

            await saveSettings(settings);
            console.log(`\n[?] Target update berhasil diubah.`);
        }
        else if (choice === '5') {
            console.log("\n--- ATUR MAX PRICE ---");
            console.log("1. Aktif (Harga maksimal diset sama dengan harga modal dari seller yang dipilih)");
            console.log("2. Non-Aktif (Harga maksimal diset Rp 0 / tanpa batas)");
            const maxChoice = await askQuestion('> Pilih (1/2) : ');
            settings.useMaxPrice = maxChoice === '1';
            await saveSettings(settings);
            console.log(`\n[?] Max Price berhasil diset: ${settings.useMaxPrice ? 'ON' : 'OFF'}.`);
        }
        else if (choice === '6') {
            const codeChoice = await askCodeMode();
            settings.autoCodeMode = parseCodeMode(codeChoice);
            await saveSettings(settings);
            console.log(`\n[?] Generate Kode Produk diubah menjadi: ${codeModeText(settings.autoCodeMode)}.`);
        }
        else if (choice === '7') {
            await executeAutoUpdateProcess();
        }
        else if (choice === '8') {
            break;
        }
    }
}

// ==========================================
// PROCESS AUTO UPDATE SELLER (CEK TYPE & BRAND)
// ==========================================
async function executeAutoUpdateProcess() {
    console.log('\n======================================');
    console.log('?? MENJALANKAN PROCESS AUTO UPDATE SELLER ??');
    console.log('======================================\n');

    try {
        const sessionData = await loadSession();
        if (!sessionData) return console.log("[!] Sesi tidak ditemukan. Harap login terlebih dahulu.");

        const { client, jar } = createClient(sessionData);
        const csrf = await getCsrf(jar);
        const headers = digiHeaders(csrf);

        const settings = await loadSettings();
        const blacklist = await loadBlacklist();
        const lowerBlacklist = blacklist.map(n => n.toLowerCase());
        const skipSellersRuntime = new Set();

        console.log(`[~] Mode Target : ${settings.targetType === 'gangguan' ? 'PRODUK STOK 0 / GANGGUAN' : 'SEMUA PRODUK'}`);
        console.log(`[~] Kriteria    : Min Rating ${settings.minRating} | Min Pemberi Rating ${settings.minRatingQty ?? 0} | Wajib Multi: Ya | Urutan: ${settings.sortPrice}`);
        console.log(`[~] Max Price   : ${settings.useMaxPrice ? 'ON' : 'OFF'}`);
        console.log(`[~] Generate Kode Produk : ${codeModeText(settings.autoCodeMode || 'off')}\n`);

        console.log("[~] Mengambil daftar kategori & brand...");
        const [catRes, brandRes] = await Promise.all([
            requestWithRetry(() => client.get(`${DIGI_BASE}/api/v1/buyer/product/category`, { headers })),
            requestWithRetry(() => client.get(`${DIGI_BASE}/api/v1/buyer/product/brand`, { headers }))
        ]);

        const categories = catRes.data?.data || [];
        const brands = brandRes.data?.data || [];

        let totalSelesai = 0;
        let totalGagal = 0;

        for (const cat of categories) {
            const catName = cat.name || cat.category_name;
            console.log(`\ncek type : ${catName}`);

            let catProducts = [];
            try {
                const prodRes = await requestWithRetry(() => client.get(`${DIGI_BASE}/api/v1/buyer/product/category/${cat.id}`, { headers }));
                catProducts = prodRes.data?.data || [];
            } catch (e) {
                console.log(`   [X] Gagal mengambil produk tipe ${catName}: ${e.message}`);
                continue;
            }

            if (catProducts.length === 0) continue;

            // Filter brand yang memiliki produk dalam kategori ini
            for (const brand of brands) {
                const brandName = brand.name || brand.brand_name;

                const brandProducts = catProducts.filter(p =>
                    p.brand_id === brand.id ||
                    p.product_details?.brand?.id === brand.id ||
                    (p.brand && String(p.brand).toLowerCase() === String(brandName).toLowerCase())
                );

                if (brandProducts.length === 0) continue;

                console.log(`cek brand : ${brandName}`);

                for (const prod of brandProducts) {
                    const productName = prod.product || prod.name;

                    // [FIX] Validasi apakah stok 0 (dengan membedakan unlimited_stock) atau status gangguan
                    const isStockKosong = (String(prod.stock) === '0' || prod.stock === 0) && prod.unlimited_stock !== true;
                    const valStatus = String(prod.status_sellerSku || '').toUpperCase();
                    const isGangguan = valStatus === 'GANGGUAN' || valStatus === '0' || valStatus === 'FALSE';
                    const isStatusFalse = prod.status === false || String(prod.status).toUpperCase() === 'FALSE';

                    const needsUpdate = settings.targetType === 'semua' || (isStockKosong || isGangguan || isStatusFalse);

                    if (!needsUpdate) {
                        continue; // Stok aman, lanjut ke produk berikutnya
                    }

                    console.log(`   [!] Stok Kosong / Bermasalah: ${productName} (Stok: ${prod.stock}) -> Mencari seller pengganti...`);

                    try {
                        const sellerRes = await requestWithRetry(() => client.get(`${DIGI_BASE}/api/v1/buyer/product/seller/${prod.id}`, { headers }));
                        let sellers = sellerRes.data?.data || [];

                        // [FIX] Filter seller pengganti yang ready stok & memenuhi syarat
                        sellers = sellers.filter(s => {
                            const sStatus = String(s.status_sellerSku || '').toUpperCase();
                            const sIsGangguan = sStatus === 'GANGGUAN' || sStatus === '0' || sStatus === 'FALSE';

                            // Cek Unlimited Stock
                            // [NEW] Stok 0 dianggap unlimited (tetap lolos), bukan kosong
                            const sHasStock = true;

                            // Pastikan status produk dari seller memang sedang aktif
                            const isActive = s.status === true || String(s.status).toUpperCase() === 'TRUE';

                            const isBlacklisted = lowerBlacklist.includes(String(s.seller).toLowerCase());
                            const ratingOk = (parseFloat(s.reviewAvg) || 0) >= settings.minRating;

                            // [FIX] Auto-skip seller yang mewajibkan KTP/faktur pajak (HTTP 400 di server).
                            // Ditandai faturPajak true di seller_details, atau seller sku-nya wajib faktur.
                            const sellerDetails = s.seller_details || {};
                            const isFakturWajib = sellerDetails.faturPajak === true || s.faktur === true;
                            const isSkippedRuntime = skipSellersRuntime.has(String(s.seller).toLowerCase());

                            // [NEW] Produk wajib multi (transaksi bisa lebih dari 1x)
                            const isMultiOk = s.multi === true;

                            // [NEW] Minimal jumlah orang pemberi rating (rating_qty "60+" -> 60)
                            const ratingQtyOk = parseRatingQty(s.rating_qty) >= (settings.minRatingQty ?? 0);

                            return !sIsGangguan && sHasStock && isActive && !isBlacklisted && ratingOk && !isFakturWajib && !isSkippedRuntime && isMultiOk && ratingQtyOk;
                        });

                        if (sellers.length === 0) {
                            console.log(`      +- [SKIP] Tidak ada seller pengganti yang memenuhi kriteria.`);
                            continue;
                        }

                        // Sorting seller
                        if (settings.sortPrice === 'termurah') sellers.sort((a, b) => a.price - b.price);
                        else if (settings.sortPrice === 'termahal') sellers.sort((a, b) => b.price - a.price);
                        else if (settings.sortPrice === 'random') sellers.sort(() => Math.random() - 0.5);

                        // [FIX] Coba seller satu per satu sampai ada yang berhasil,
                        // agar seller bermasalah (mis. wajib KTP) otomatis dilewati & dicoba seller berikutnya.
                        let updateDone = false;
                        let hardFail = false;
                        for (const chosenSeller of sellers) {
                            // [FIX] Payload meniru persis body POST dari browser (DevTools).
                            // seller_sku_code TIDAK diganti dengan kode seller baru (kode asli produk dipertahankan),
                            // field teks diberi fallback agar key tidak hilang dari JSON (hindari 422).
                            const updatePayload = {
                                id: prod.id,
                                code: resolveSkuCode(prod, settings.autoCodeMode || 'off'), // Kode Produk (form "code"), auto-generate sesuai mode
                                max_price: settings.useMaxPrice ? Number(chosenSeller.price) : 0,
                                product: prod.product || prod.name,
                                product_id: prod.product_id,
                                product_details: prod.product_details,
                                description: prod.description,
                                price: Number(chosenSeller.price) || 0,
                                stock: Number(chosenSeller.stock) || 0,
                                start_cut_off: chosenSeller.start_cut_off ?? prod.start_cut_off ?? '00:00',
                                end_cut_off: chosenSeller.end_cut_off ?? prod.end_cut_off ?? '00:00',
                                unlimited_stock: chosenSeller.unlimited_stock === true,
                                faktur: chosenSeller.faktur === true,
                                multi: chosenSeller.multi === true,
                                multi_counter: Number(chosenSeller.multi_counter) || 0,
                                seller: chosenSeller.seller,
                                seller_sku_id: chosenSeller.id,
                                seller_sku_id_int: Number(chosenSeller.id_int) || 0,
                                seller_connection_type: chosenSeller.connectionType ?? 'api',
                                seller_sku_code: prod.seller_sku_code, // kode asli produk, bukan kode seller
                                seller_details: chosenSeller.seller_details ?? {},
                                status: true,
                                status_sellerSku: chosenSeller.status_sellerSku ?? 1,
                                sort_order: prod.sort_order ?? 0,
                                seller_sku_desc: chosenSeller.deskripsi ?? '',
                                change: true
                            };

                            const skuCode = resolveSkuCode(prod, settings.autoCodeMode || 'off');
                            if (skuCode && skuCode !== (prod.code || '')) {
                                console.log(`      +- [KODE] "${prod.product || prod.name}" -> Kode Produk dibuat: ${skuCode}`);
                            }

                            try {
                                await requestWithRetry(() => client.post(`${DIGI_BASE}/api/v1/buyer/product`, updatePayload, { headers }));
                                console.log(`      +- [?] BERHASIL DIGANTI -> Seller: ${chosenSeller.seller} | Harga: Rp ${chosenSeller.price.toLocaleString('id-ID')}`);
                                totalSelesai++;
                                updateDone = true;
                                break;
                            } catch (e) {
                                if (isSessionExpired(e)) {
                                    console.log(`      +- [X] Sesi expired (HTTP ${e.response?.status}). Proses dihentikan, silakan login ulang.`);
                                    return;
                                }
                                const status = e.response?.status;
                                const msg = String(e.response?.data?.message || '');
                                // 400 = penolakan bisnis server (mis. seller wajib KTP) -> tandai & coba seller berikutnya
                                if (status === 400) {
                                    console.log(`      +- [SKIP] Seller "${chosenSeller.seller}" ditolak server: ${msg || e.message}. Mencoba seller berikutnya...`);
                                    skipSellersRuntime.add(String(chosenSeller.seller).toLowerCase());
                                    continue;
                                }
                                console.log(`      +- [X] Gagal update seller: ${errorDetail(e)}`);
                                totalGagal++;
                                hardFail = true;
                                break;
                            }
                        }
                        if (!updateDone && !hardFail) {
                            console.log(`      +- [SKIP] Semua kandidat seller ditolak/bermasalah. Produk dilewati.`);
                        }
                    } catch (e) {
                        if (isSessionExpired(e)) {
                            console.log(`      +- [X] Sesi expired (HTTP ${e.response?.status}). Proses dihentikan, silakan login ulang.`);
                            return;
                        }
                        console.log(`      +- [X] Gagal update seller: ${errorDetail(e)}`);
                        totalGagal++;
                    } finally {
                        await sleep(2000);
                    }
                }
            }
        }

        console.log('\n======================================');
        console.log(`? AUTO UPDATE SELESAI | Berhasil: ${totalSelesai} | Gagal: ${totalGagal}`);
        console.log('======================================\n');

    } catch (err) {
        console.log(`\n[X] Terjadi kesalahan fatal: ${err.message}`);
    }
}

// ==========================================
// BLACKLIST & WIZARD
// ==========================================
async function manageBlacklist() {
    const blacklist = await loadBlacklist();
    console.log("\n=== DAFTAR BLACKLIST SELLER ===");
    if (blacklist.length === 0) console.log("Data blacklist masih kosong.");
    else blacklist.forEach((name, i) => console.log(`${i + 1}. ${name}`));

    console.log("\nOpsi:\n1. Tambah ke Blacklist\n2. Hapus dari Blacklist\n3. Kembali ke Menu Utama");
    const choice = await askQuestion('> Pilih opsi (1/2/3) : ');

    if (choice === '1') {
        const name = await askQuestion('> Masukkan nama seller: ');
        if (name.trim() && !blacklist.map(n => n.toLowerCase()).includes(name.trim().toLowerCase())) {
            blacklist.push(name.trim());
            await saveBlacklist(blacklist);
            console.log(`\n[?] Seller '${name.trim()}' berhasil ditambahkan.`);
        }
    } else if (choice === '2') {
        const no = parseInt(await askQuestion('> Masukkan nomor urut seller: '));
        if (no > 0 && no <= blacklist.length) {
            const removed = blacklist.splice(no - 1, 1);
            await saveBlacklist(blacklist);
            console.log(`\n[?] Seller '${removed[0]}' dihapus.`);
        }
    }
}

async function startWizard() {
    try {
        const sessionData = await loadSession();
        const { client, jar } = createClient(sessionData);
        const csrf = await getCsrf(jar);
        const headers = digiHeaders(csrf);
        const settings = await loadSettings();

        console.log("\n[~] Mengambil daftar semua kategori...");
        const catRes = await requestWithRetry(() => client.get(`${DIGI_BASE}/api/v1/buyer/product/category`, { headers }));
        const categories = catRes.data.data;

        console.log("\n=== PILIH KATEGORI ===");
        categories.forEach((cat, idx) => console.log(`${idx + 1}. ${cat.name || cat.category_name}`));

        let catIdx;
        while (true) {
            catIdx = parseInt(await askQuestion('\n> Pilih Kategori (0 untuk batal) : '));
            if (catIdx === 0) return;
            if (catIdx > 0 && catIdx <= categories.length) break;
        }
        const selectedCategory = categories[catIdx - 1];

        console.log(`\n[~] Mengambil daftar semua brand...`);
        const brandRes = await requestWithRetry(() => client.get(`${DIGI_BASE}/api/v1/buyer/product/brand`, { headers }));
        const brands = brandRes.data.data;

        console.log("\n=== PILIH BRAND ===");
        brands.forEach((b, idx) => console.log(`${idx + 1}. ${b.name || b.brand_name}`));

        let brandIdx;
        while (true) {
            brandIdx = parseInt(await askQuestion('\n> Pilih Brand (0 untuk batal) : '));
            if (brandIdx === 0) return;
            if (brandIdx > 0 && brandIdx <= brands.length) break;
        }
        const selectedBrand = brands[brandIdx - 1];

        console.log(`\n=== PENGATURAN SELLER ===`);
        const ratingInput = await askQuestion('> Minimal Rating (0-5) [default: 4.0] : ');
        const minRating = ratingInput.trim() !== '' ? parseFloat(ratingInput) : 4.0;

        const ratingQtyInput = await askQuestion('> Minimal Pemberi Rating (jumlah orang, misal 10) [default: 0] : ');
        const minRatingQty = ratingQtyInput.trim() !== '' && !isNaN(parseFloat(ratingQtyInput)) ? parseFloat(ratingQtyInput) : 0;

        const sortChoice = await askQuestion('> Pilihan Sort (1:Termurah, 2:Termahal, 3:Random) [default: 1] : ');
        let sortPrice = sortChoice === '2' ? 'termahal' : (sortChoice === '3' ? 'random' : 'termurah');

        const codeChoice = await askCodeMode();
        const autoCodeMode = parseCodeMode(codeChoice);
        console.log(`[~] Mode Generate Kode Produk: ${codeModeText(autoCodeMode)}`);

        console.log(`\n[~] Mengambil produk di kategori...`);
        const prodRes = await requestWithRetry(() => client.get(`${DIGI_BASE}/api/v1/buyer/product/category/${selectedCategory.id}`, { headers }));

        let targetProducts = prodRes.data.data.filter(p => p.brand_id === selectedBrand.id || p.product_details?.brand?.id === selectedBrand.id);
        if (targetProducts.length === 0) return console.log(`[!] Tidak ada produk untuk brand tersebut.`);

        const blacklist = await loadBlacklist();
        const lowerBlacklist = blacklist.map(n => n.toLowerCase());
        const skipSellersRuntime = new Set();

        console.log(`\n?? MEMULAI PROSES UPDATE (${targetProducts.length} produk)`);

        for (const prod of targetProducts) {
            try {
                const sellerRes = await requestWithRetry(() => client.get(`${DIGI_BASE}/api/v1/buyer/product/seller/${prod.id}`, { headers }));

                // [FIX] Samakan logika filter Wizard dengan Auto Update agar konsisten
                let sellers = sellerRes.data.data.filter(s => {
                    const valStatus = String(s.status_sellerSku || '').toUpperCase();
                    const isGangguan = valStatus === 'GANGGUAN' || valStatus === '0' || valStatus === 'FALSE';
                    // [NEW] Stok 0 dianggap unlimited (tetap lolos), bukan kosong
                    const isKosong = false;
                    const isActive = s.status === true || String(s.status).toUpperCase() === 'TRUE';
                    const ratingOk = (parseFloat(s.reviewAvg) || 0) >= minRating;
                    const notBlacklisted = !lowerBlacklist.includes(String(s.seller).toLowerCase());

                    // [FIX] Auto-skip seller wajib KTP/faktur pajak + yang sudah ditolak server sebelumnya
                    const sellerDetails = s.seller_details || {};
                    const isFakturWajib = sellerDetails.faturPajak === true || s.faktur === true;
                    const isSkippedRuntime = skipSellersRuntime.has(String(s.seller).toLowerCase());

                    // [NEW] Produk wajib multi (transaksi bisa lebih dari 1x)
                    const isMultiOk = s.multi === true;

                    // [NEW] Minimal jumlah orang pemberi rating (rating_qty "60+" -> 60)
                    const ratingQtyOk = parseRatingQty(s.rating_qty) >= minRatingQty;

                    return !isGangguan && !isKosong && isActive && ratingOk && notBlacklisted && !isFakturWajib && !isSkippedRuntime && isMultiOk && ratingQtyOk;
                });

                if (sellers.length === 0) {
                    console.log(`[SKIP] ${prod.product || prod.name} ? Tidak ada seller memenuhi kriteria.`);
                    continue;
                }

                if (sortPrice === 'termurah') sellers.sort((a, b) => a.price - b.price);
                else if (sortPrice === 'termahal') sellers.sort((a, b) => b.price - a.price);
                else sellers.sort(() => Math.random() - 0.5);

                // [FIX] Coba seller satu per satu sampai ada yang berhasil
                for (const chosen of sellers) {
                    // [FIX] Payload meniru persis body POST dari browser (DevTools).
                    // seller_sku_code memakai kode asli produk; field teks diberi fallback agar tidak undefined.
                    const updatePayload = {
                        id: prod.id,
                        code: resolveSkuCode(prod, autoCodeMode || 'off'), // Kode Produk (form "code"), auto-generate sesuai mode
                        max_price: settings.useMaxPrice ? Number(chosen.price) : 0,
                        product: prod.product || prod.name,
                        product_id: prod.product_id,
                        product_details: prod.product_details,
                        description: prod.description,
                        price: Number(chosen.price) || 0,
                        stock: Number(chosen.stock) || 0,
                        start_cut_off: chosen.start_cut_off ?? prod.start_cut_off ?? '00:00',
                        end_cut_off: chosen.end_cut_off ?? prod.end_cut_off ?? '00:00',
                        unlimited_stock: chosen.unlimited_stock === true,
                        faktur: chosen.faktur === true,
                        multi: chosen.multi === true,
                        multi_counter: Number(chosen.multi_counter) || 0,
                        seller: chosen.seller,
                        seller_sku_id: chosen.id,
                        seller_sku_id_int: Number(chosen.id_int) || 0,
                        seller_connection_type: chosen.connectionType ?? 'api',
                        seller_sku_code: prod.seller_sku_code, // kode asli produk, bukan kode seller
                        seller_details: chosen.seller_details ?? {},
                        status: true,
                        status_sellerSku: chosen.status_sellerSku ?? 1,
                        sort_order: prod.sort_order ?? 0,
                        seller_sku_desc: chosen.deskripsi ?? '',
                        change: true
                    };

                    const skuCode = resolveSkuCode(prod, autoCodeMode || 'off');
                    if (skuCode && skuCode !== (prod.code || '')) {
                        console.log(`[KODE] "${prod.product || prod.name}" -> Kode Produk dibuat: ${skuCode}`);
                    }

                    try {
                        await requestWithRetry(() => client.post(`${DIGI_BASE}/api/v1/buyer/product`, updatePayload, { headers }));
                        console.log(`[?] FIX: ${prod.product || prod.name} ? ${chosen.seller} (Rp ${chosen.price.toLocaleString('id-ID')})`);
                        break;
                    } catch (err) {
                        if (isSessionExpired(err)) {
                            console.log(`[X] Sesi expired (HTTP ${err.response?.status}). Proses dihentikan, silakan login ulang.`);
                            return;
                        }
                        const status = err.response?.status;
                        const msg = String(err.response?.data?.message || '');
                        // 400 = penolakan bisnis server (mis. seller wajib KTP) -> tandai & coba seller berikutnya
                        if (status === 400) {
                            console.log(`[SKIP] Seller "${chosen.seller}" ditolak server: ${msg || err.message}. Mencoba seller berikutnya...`);
                            skipSellersRuntime.add(String(chosen.seller).toLowerCase());
                            continue;
                        }
                        console.log(`[X] Gagal memproses ${prod.product || prod.name}: ${errorDetail(err)}`);
                        break;
                    }
                }
            } catch (err) {
                if (isSessionExpired(err)) {
                    console.log(`[X] Sesi expired (HTTP ${err.response?.status}). Proses dihentikan, silakan login ulang.`);
                    return;
                }
                console.log(`[X] Gagal memproses ${prod.product || prod.name}: ${errorDetail(err)}`);
            } finally {
                await sleep(2000);
            }
        }
        console.log('\n?? PROSES SELESAI ??\n');
    } catch (err) {
        console.log("\n[X] Error:", err.message);
    }
}

// ==========================================
// STARTUP LOGIC
// ==========================================
async function start() {
    startDaemon();

    const sessionData = await loadSession();
    if (!sessionData) return await login();

    try {
        const { client, jar } = createClient(sessionData);
        const csrf = await getCsrf(jar);

        const profileRes = await client.get(`${DIGI_BASE}/api/v1/buyer/account/profile`, { headers: digiHeaders(csrf) });
        displayBanner();
        console.log(`\n[?] BERHASIL MASUK (Menggunakan Session)`);
        console.log(`> Nama  : ${profileRes.data.data.user?.name}`);
        console.log(`> Saldo : Rp ${(profileRes.data.data.balance || 0).toLocaleString('id-ID')}\n`);

        await mainMenu();
    } catch (err) {
        console.log("[!] Sesi expired. Silakan login kembali.\n");
        await login();
    }
}

start();
