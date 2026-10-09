const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const rootDir = __dirname;
const dataDir = path.join(rootDir, 'data');
const dbFile = path.join(dataDir, 'medical.db');

fs.mkdirSync(dataDir, { recursive: true });

const db = new sqlite3.Database(dbFile);

app.set('view engine', 'ejs');
app.set('views', path.join(rootDir, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(rootDir, 'public')));
app.use(
  session({
    secret: 'care-nova-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
  })
);

function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function getSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function allSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDatabase() {
  await runSql(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('patient', 'doctor')),
      phone TEXT,
      city TEXT,
      specialty TEXT,
      experience INTEGER DEFAULT 0,
      fee REAL DEFAULT 0,
      bio TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      appointment_date TEXT NOT NULL,
      appointment_time TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(patient_id) REFERENCES users(id),
      FOREIGN KEY(doctor_id) REFERENCES users(id)
    )
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appointment_id INTEGER NOT NULL UNIQUE,
      patient_id INTEGER NOT NULL,
      doctor_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      receipt_code TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(appointment_id) REFERENCES appointments(id)
    )
  `);

  const doctorCount = await getSql('SELECT COUNT(*) AS count FROM users WHERE role = ?', ['doctor']);
  if (!doctorCount || doctorCount.count === 0) {
    const defaultDoctors = [
      {
        name: 'Dr. Sarah Mitchell',
        email: 'sarah@carenova.com',
        password: 'doctor123',
        phone: '+1 (555) 101-2020',
        city: 'New York',
        specialty: 'Family Medicine',
        experience: 12,
        fee: 120,
        bio: 'Experienced family physician focused on preventive care and long-term wellness.',
      },
      {
        name: 'Dr. James Patel',
        email: 'james@carenova.com',
        password: 'doctor123',
        phone: '+1 (555) 303-4040',
        city: 'Chicago',
        specialty: 'Cardiology',
        experience: 15,
        fee: 180,
        bio: 'Cardiologist dedicated to evidence-based heart care and personalized treatment plans.',
      },
      {
        name: 'Dr. Aisha Rahman',
        email: 'aisha@carenova.com',
        password: 'doctor123',
        phone: '+1 (555) 505-6060',
        city: 'Los Angeles',
        specialty: 'Pediatrics',
        experience: 10,
        fee: 130,
        bio: 'Pediatric specialist helping families with compassionate, child-centered care.',
      },
    ];

    for (const doctor of defaultDoctors) {
      await runSql(
        `INSERT INTO users (name, email, password, role, phone, city, specialty, experience, fee, bio)
         VALUES (?, ?, ?, 'doctor', ?, ?, ?, ?, ?, ?)`,
        [
          doctor.name,
          doctor.email,
          await bcrypt.hash(doctor.password, 10),
          doctor.phone,
          doctor.city,
          doctor.specialty,
          doctor.experience,
          doctor.fee,
          doctor.bio,
        ]
      );
    }

    const demoPatientPassword = await bcrypt.hash('patient123', 10);
    await runSql(
      `INSERT OR IGNORE INTO users (name, email, password, role, phone, city, specialty, experience, fee, bio)
       VALUES (?, ?, ?, 'patient', '+1 (555) 888-9999', 'Boston', NULL, 0, 0, 'Demo patient account for sample use.')`,
      ['Demo Patient', 'patient@carenova.com', demoPatientPassword]
    );
  }
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

app.get('/', async (req, res) => {
  const doctors = await allSql('SELECT * FROM users WHERE role = ? ORDER BY name ASC LIMIT 6', ['doctor']);
  res.render('index', { doctors });
});

app.get('/signup', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('signup');
});

app.post('/signup', async (req, res) => {
  const { name, email, password, role, phone, city, specialty, experience, fee, bio } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).render('signup', { error: 'Please fill out all required fields.' });
  }

  const existingUser = await getSql('SELECT * FROM users WHERE email = ?', [email.trim()]);
  if (existingUser) {
    return res.status(409).render('signup', { error: 'An account with this email already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const insertResult = await runSql(
    `INSERT INTO users (name, email, password, role, phone, city, specialty, experience, fee, bio)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name.trim(),
      email.trim(),
      passwordHash,
      role,
      phone?.trim() || null,
      city?.trim() || null,
      role === 'doctor' ? (specialty?.trim() || null) : null,
      role === 'doctor' ? Number(experience || 0) : 0,
      role === 'doctor' ? Number(fee || 0) : 0,
      role === 'doctor' ? (bio?.trim() || null) : null,
    ]
  );

  req.session.user = {
    id: insertResult.id,
    name: name.trim(),
    email: email.trim(),
    role,
  };

  res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login');
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).render('login', { error: 'Email and password are required.' });
  }

  const user = await getSql('SELECT * FROM users WHERE email = ?', [email.trim()]);
  if (!user) {
    return res.status(401).render('login', { error: 'No account found for that email.' });
  }

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) {
    return res.status(401).render('login', { error: 'Incorrect password.' });
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };

  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const user = req.session.user;

  if (user.role === 'doctor') {
    const doctor = await getSql('SELECT * FROM users WHERE id = ?', [user.id]);
    const appointments = await allSql(
      `SELECT a.*, p.name AS patient_name, p.email AS patient_email, p.phone AS patient_phone
       FROM appointments a
       JOIN users p ON p.id = a.patient_id
       WHERE a.doctor_id = ?
       ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
      [user.id]
    );

    return res.render('dashboard', {
      user: doctor,
      appointments,
      isDoctor: true,
      successMessage: req.query.success || '',
    });
  }

  const patient = await getSql('SELECT * FROM users WHERE id = ?', [user.id]);
  const appointments = await allSql(
    `SELECT a.*, d.name AS doctor_name, d.specialty AS doctor_specialty, d.phone AS doctor_phone, d.fee AS doctor_fee
     FROM appointments a
     JOIN users d ON d.id = a.doctor_id
     WHERE a.patient_id = ?
     ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
    [user.id]
  );

  res.render('dashboard', {
    user: patient,
    appointments,
    isDoctor: false,
    successMessage: req.query.success || '',
  });
});

app.get('/profile', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'doctor') return res.redirect('/dashboard');

  const doctor = await getSql('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  res.render('profile', { doctor, error: '', successMessage: req.query.success || '' });
});

app.post('/profile', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'doctor') return res.redirect('/dashboard');

  const { name, phone, city, specialty, experience, fee, bio } = req.body;

  await runSql(
    `UPDATE users
     SET name = ?, phone = ?, city = ?, specialty = ?, experience = ?, fee = ?, bio = ?
     WHERE id = ?`,
    [
      name.trim(),
      phone?.trim() || null,
      city?.trim() || null,
      specialty?.trim() || null,
      Number(experience || 0),
      Number(fee || 0),
      bio?.trim() || null,
      req.session.user.id,
    ]
  );

  req.session.user.name = name.trim();
  res.redirect('/profile?success=' + encodeURIComponent('Profile updated successfully.'));
});

app.get('/doctors', async (req, res) => {
  const doctors = await allSql('SELECT * FROM users WHERE role = ? ORDER BY name ASC', ['doctor']);
  res.render('doctors', { doctors });
});

app.get('/doctors/:id', async (req, res) => {
  const doctor = await getSql('SELECT * FROM users WHERE id = ? AND role = ?', [req.params.id, 'doctor']);
  if (!doctor) return res.status(404).send('Doctor not found.');
  res.render('doctor-profile', { doctor });
});

app.get('/book/:doctorId', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'patient') return res.redirect('/dashboard');

  const doctor = await getSql('SELECT * FROM users WHERE id = ? AND role = ?', [req.params.doctorId, 'doctor']);
  if (!doctor) return res.status(404).send('Doctor not found.');

  res.render('booking', { doctor, error: '' });
});

app.post('/book/:doctorId', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'patient') return res.redirect('/dashboard');

  const doctorId = Number(req.params.doctorId);
  const { appointment_date, appointment_time, notes } = req.body;

  if (!appointment_date || !appointment_time) {
    const doctor = await getSql('SELECT * FROM users WHERE id = ? AND role = ?', [doctorId, 'doctor']);
    return res.status(400).render('booking', { doctor, error: 'Please select appointment date and time.' });
  }

  const appointmentResult = await runSql(
    `INSERT INTO appointments (patient_id, doctor_id, appointment_date, appointment_time, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [req.session.user.id, doctorId, appointment_date, appointment_time, notes?.trim() || null]
  );

  const doctor = await getSql('SELECT * FROM users WHERE id = ? AND role = ?', [doctorId, 'doctor']);
  const amount = Number(doctor.fee || 0);
  const receiptCode = `RX-${Date.now()}-${appointmentResult.id}`;

  await runSql(
    `INSERT INTO receipts (appointment_id, patient_id, doctor_id, amount, receipt_code)
     VALUES (?, ?, ?, ?, ?)`,
    [appointmentResult.id, req.session.user.id, doctorId, amount, receiptCode]
  );

  res.redirect('/dashboard?success=' + encodeURIComponent('Appointment booked. Your receipt is ready to download.'));
});

app.post('/appointments/:id/status', requireAuth, async (req, res) => {
  if (req.session.user.role !== 'doctor') return res.redirect('/dashboard');

  const appointmentId = Number(req.params.id);
  const { status } = req.body;

  await runSql('UPDATE appointments SET status = ? WHERE id = ? AND doctor_id = ?', [status, appointmentId, req.session.user.id]);

  res.redirect('/dashboard');
});

app.get('/appointments/:id/receipt', requireAuth, async (req, res) => {
  const appointmentId = Number(req.params.id);

  const appointment = await getSql(
    `SELECT a.*, p.name AS patient_name, p.email AS patient_email, p.phone AS patient_phone,
            d.name AS doctor_name, d.specialty AS doctor_specialty, d.phone AS doctor_phone, d.fee AS doctor_fee
     FROM appointments a
     JOIN users p ON p.id = a.patient_id
     JOIN users d ON d.id = a.doctor_id
     WHERE a.id = ?`,
    [appointmentId]
  );

  if (!appointment) return res.status(404).send('Appointment not found.');

  if (req.session.user.role === 'patient' && appointment.patient_id !== req.session.user.id) {
    return res.status(403).send('You are not allowed to access this receipt.');
  }

  if (req.session.user.role === 'doctor' && appointment.doctor_id !== req.session.user.id) {
    return res.status(403).send('You are not allowed to access this receipt.');
  }

  let receipt = await getSql('SELECT * FROM receipts WHERE appointment_id = ?', [appointmentId]);
  if (!receipt) {
    const receiptCode = `RX-${Date.now()}-${appointmentId}`;
    const amount = Number(appointment.doctor_fee || 0);
    const created = await runSql(
      `INSERT INTO receipts (appointment_id, patient_id, doctor_id, amount, receipt_code)
       VALUES (?, ?, ?, ?, ?)`,
      [appointmentId, appointment.patient_id, appointment.doctor_id, amount, receiptCode]
    );
    receipt = await getSql('SELECT * FROM receipts WHERE id = ?', [created.id]);
  }

  const pdf = new PDFDocument({ margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${receipt.receipt_code}.pdf"`);
  pdf.pipe(res);

  pdf.fontSize(22).text('CareNova Medical', { align: 'center' });
  pdf.moveDown();
  pdf.fontSize(14).text('Official Appointment Receipt', { underline: true });
  pdf.moveDown();

  pdf.fontSize(11).text(`Receipt ID: ${receipt.receipt_code}`);
  pdf.text(`Appointment Date: ${appointment.appointment_date}`);
  pdf.text(`Appointment Time: ${appointment.appointment_time}`);
  pdf.text(`Patient: ${appointment.patient_name}`);
  pdf.text(`Doctor: ${appointment.doctor_name}`);
  pdf.text(`Specialty: ${appointment.doctor_specialty || 'General'}`);
  pdf.text(`Status: ${appointment.status || 'pending'}`);
  pdf.text(`Amount Paid: $${Number(receipt.amount).toFixed(2)}`);
  pdf.text(`Issued: ${new Date(receipt.created_at).toLocaleString()}`);
  pdf.moveDown();
  pdf.text('Thank you for choosing CareNova Medical. We look forward to supporting your care journey.');
  pdf.end();
});

app.get('/api/doctors', async (req, res) => {
  const doctors = await allSql('SELECT id, name, specialty, city, fee, experience FROM users WHERE role = ? ORDER BY name ASC', ['doctor']);
  res.json(doctors);
});

async function startServer() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Medical website running at http://localhost:${PORT}`);
  });
}

startServer();
