const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
    if (isReady) {
        socket.emit('ready', 'WhatsApp Client is ready!');
        socket.emit('log', 'WhatsApp Client is already connected and ready.');
    }
});

// Store uploaded files in 'uploads' directory
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

// Initialize WhatsApp Client with LocalAuth to save session
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: 'new', // Use the new headless mode for better compatibility
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-features=IsolateOrigins,site-per-process',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        ],
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

let isReady = false;

client.on('qr', (qr) => {
    console.log('QR Code received');
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Error generating QR code', err);
            return;
        }
        io.emit('qr', url);
        io.emit('log', 'Please scan the QR code to login.');
    });
});

client.on('ready', async () => {
    console.log('Client is ready! Waiting 5s for session to stabilize...');
    await sleep(5000); // Give it time to load all internal stores
    isReady = true;
    io.emit('ready', 'WhatsApp Client is ready!');
    io.emit('log', 'WhatsApp Client is connected and ready to send.');
});

client.on('authenticated', () => {
    console.log('Authenticated');
    io.emit('log', 'Authenticated successfully.');
    io.emit('clear_qr');
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    io.emit('log', 'Authentication failed. Please restart.');
});

console.log('Initializing WhatsApp client...');
io.emit('log', 'جاري تهيئة الواتساب... يرجى الانتظار.');

client.initialize().catch(err => {
    console.error('Failed to initialize WhatsApp client:', err);
    io.emit('log', 'فشل في التشغيل: ' + err.message);
});

// Function to generate random delay within a range
const getRandomDelay = (min = 20, max = 60) => {
    return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
};

// Function to sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
        let rows = [];
        if (req.file.originalname.endsWith('.txt') || req.file.mimetype === 'text/plain') {
            const content = fs.readFileSync(req.file.path, 'utf8');
            rows = content.split(/\r?\n/).map(line => {
                const num = line.trim();
                return num ? { Name: 'Customer', Number: num } : null;
            }).filter(Boolean);
        } else {
            const workbook = xlsx.readFile(req.file.path);
            const sheetName = workbook.SheetNames[0];
            const rawRows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });

            // Skip header if it looks like text and not a number
            const startIdx = (rawRows.length > 0 && isNaN(String(rawRows[0][0]).replace(/[^0-9]/g, ''))) ? 1 : 0;

            rows = rawRows.slice(startIdx).map(row => {
                const number = row[0];
                const name = row[1] || 'صديقي'; // Default to "صديقي" if name is missing
                return number ? { Number: number, Name: name } : null;
            }).filter(Boolean);
        }

        // Cleanup uploaded file
        fs.unlinkSync(req.file.path);

        res.json({ count: rows.length, data: rows });
    } catch (error) {
        console.error('File process error:', error);
        res.status(500).json({ error: 'Failed to process file' });
    }
});

let stopSending = false;

app.post('/stop', (req, res) => {
    stopSending = true;
    io.emit('log', '⚠️ تم طلب إيقاف الإرسال... سيتم التوقف بعد إكمال العملية الحالية.');
    res.json({ message: 'Stop signal received' });
});

app.post('/send', async (req, res) => {
    if (!isReady) {
        return res.status(400).json({ error: 'WhatsApp client is not ready. Please scan QR code first.' });
    }

    const { recipients, template, speedSettings, aiEnabled, stealthMode } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: 'No recipients provided' });
    }

    if (!template) {
        return res.status(400).json({ error: 'No message template provided' });
    }

    const { minDelay = 20, maxDelay = 60, batchSize = 15, breakDuration = 300 } = speedSettings || {};

    stopSending = false;
    res.json({ message: 'Sending process started' });

    let burstCounter = 0;
    const burstLimit = Math.floor(Math.random() * 3) + 2; // Real human burst: 2-4 messages

    for (let i = 0; i < recipients.length; i++) {
        if (stopSending) {
            io.emit('log', '🛑 تم إيقاف العملية بنجاح.');
            break;
        }

        // Long break logic (Batching)
        if (i > 0 && i % batchSize === 0) {
            const extraBreak = Math.floor(Math.random() * 120); // Add 0-2 mins random extra
            const totalBreak = breakDuration + extraBreak;
            io.emit('log', `☕ استراحة غداء/استراحة قهوة مطولة لزيادة الأمان (${Math.floor(totalBreak / 60)} دقيقة)...`);
            await sleep(totalBreak * 1000);
        }

        const recipient = recipients[i];
        let name = recipient.Name || recipient.name || 'Merchant';
        let number = recipient.Number || recipient.number || recipient.Mobile || recipient.phone;

        if (!number) {
            io.emit('log', `Skipping row ${i + 1}: No number found.`);
            continue;
        }

        let formattedNumber = String(number).replace(/[^0-9]/g, '');

        try {
            let finalNumber = formattedNumber;
            io.emit('log', `[${i + 1}/${recipients.length}] ✍️ جاري كتابة رسالة مخصصة لـ ${name}...`);

            try {
                let message;

                // Ultimate Stealth Variation Logic (Refined per User audio)
                if (stealthMode) {
                    const greetings = [
                        `السلام عليكم يا ${name}،`,
                        `أهلاً بك يا ${name}،`,
                        `مرحباً ${name}،`,
                        `يسعد أوقاتك يا ${name}،`,
                        `كيف حالك يا ${name}؟`,
                        `تحية طيبة يا ${name}،`
                    ];
                    const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];

                    // Remove the user's original {name} part if it's at the beginning to avoid duplication
                    // But to be safe and keep user content as requested, we just prepend the greeting
                    // and ensure the template itself is processed.
                    let baseMessage = template.replace(/{name}/g, name);

                    // If the user's message already starts with a generic greeting, we can just replace the whole thing
                    // or just prepend. The user said "don't change my message content".
                    // So we will just use the randomized greeting and then the user's message.
                    message = `${randomGreeting}\n${baseMessage}`;
                } else {
                    message = template.replace(/{name}/g, name);
                }

                const chatId = `${finalNumber}@c.us`;
                const chat = await client.getChatById(chatId);
                const msg = await chat.sendMessage(message, { sendSeen: false });

                if (msg && msg.id) {
                    io.emit('log', `✅ تم الإرسال بنجاح إلى ${name}.`);
                } else {
                    io.emit('log', `❓ الحالة غير أكيدة للرقم ${name}.`);
                }
            } catch (err) {
                console.error('Send error details:', err.message);
                if (err.message.includes('No LID') || err.message.includes('wid is invalid') || err.message.includes('chatId is invalid')) {
                    io.emit('log', `❌ الرقم ${finalNumber} ليس لديه واتساب.`);
                } else {
                    io.emit('log', `❌ عطل فني لـ ${name}: ${err.message.split('\n')[0]}`);
                }
            }

        } catch (err) {
            console.error('Outer send error:', err);
            io.emit('log', `[ERROR] ❌ خطأ غير متوقع: ${err.message}`);
        }

        // STEALTH DELAY LOGIC
        if (i < recipients.length - 1) {
            let delay;
            if (stealthMode) {
                burstCounter++;
                if (burstCounter >= burstLimit) {
                    // LONG "Think" Pause
                    delay = getRandomDelay(45, 90);
                    io.emit('log', `🧘 وضع التخفي: استراحة "تفكير" مطولة (${delay / 1000} ثانية)...`);
                    burstCounter = 0;
                } else {
                    // SHORT "Typing" Pause
                    delay = getRandomDelay(8, 15);
                    io.emit('log', `⌨️ وضع التخفي: كتابة سريعة (${delay / 1000} ثانية)...`);
                }
            } else {
                delay = getRandomDelay(minDelay, maxDelay);
                io.emit('log', `⏱️ سأنتظر ${delay / 1000} ثانية قبل الإرسال التالي...`);
            }
            await sleep(delay);
        }
    }

    io.emit('log', '🎉 العملية انتهت بنجاح وأمان!');
});

const PORT = 3005;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
