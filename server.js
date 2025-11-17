// File: server.js (MySQL Version with Expanded Search)
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DAILY_FINE_RATE = 100;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let db;

// --- MySQL Connection Pool ---
(async () => {
    try {
        db = await mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            connectionLimit: 10,
            queueLimit: 0
        });
        console.log('✅ Successfully connected to the MySQL database!');
    } catch (error) {
        console.error('❌ Could not connect to the database:', error);
        process.exit(1);
    }
})();

// --- ============================ ---
// --- AUTHENTICATION ROUTES ---
// --- ============================ ---

// 1. Student Registration
app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Name, email, and password are required.' });
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        // Step 1: Create the 'user' for login
        const [userResult] = await connection.query(
            'INSERT INTO users (email, password, role) VALUES (?, ?, ?)',
            [email, password, 'student']
        );
        const newUserId = userResult.insertId;

        // Step 2: Create the 'member' for borrowing, linking it to the user
        const joinDate = new Date().toISOString().split('T')[0];
        await connection.query(
            'INSERT INTO members (name, email, joinDate, userId) VALUES (?, ?, ?, ?)',
            [name, email, joinDate, newUserId]
        );
        
        await connection.commit();
        res.status(201).json({ id: newUserId, email, role: 'student', name });
        
    } catch (err) {
        await connection.rollback(); 
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'This email is already registered.' });
        }
        console.error("Register Error:", err);
        res.status(500).json({ message: err.message });
    } finally {
        connection.release();
    }
});

// 2. Login
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required.' });
        }

        const [rows] = await db.query(
            'SELECT * FROM users WHERE email = ? AND password = ?',
            [email, password]
        );

        if (rows.length > 0) {
            const user = rows[0];
            res.json({ id: user.id, email: user.email, role: user.role });
        } else {
            res.status(401).json({ message: 'Invalid email or password.' });
        }
    } catch (err) {
        console.error("Login Error:", err);
        res.status(500).json({ message: err.message });
    }
});

// --- STUDENT PROFILE ROUTE ---
app.get('/api/my-profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const [memberRows] = await db.query('SELECT * FROM members WHERE userId = ?', [userId]);
        if (memberRows.length === 0) {
            return res.status(404).json({ message: "No library member profile found for this user." });
        }
        const member = memberRows[0];

        const [borrowedBooks] = await db.query(
             'SELECT bookTitle, DATE_FORMAT(dueDate, "%Y-%m-%d") as dueDate FROM borrowed_records WHERE memberId = ?',
            [member.id]
        );

        res.json({
            memberId: member.id,
            name: member.name,
            email: member.email,
            joinDate: member.joinDate,
            booksBorrowed: member.booksBorrowed,
            outstandingFines: member.outstandingFines,
            borrowedBooksList: borrowedBooks
        });

    } catch (err) {
        console.error("My Profile Error:", err);
        res.status(500).json({ message: err.message });
    }
});


// --- STUDENT BORROW ROUTE ---
app.post('/api/student/borrow', async (req, res) => {
    const { bookId, dueDate, userId } = req.body;

    let member;
    try {
        const [memberRows] = await db.query('SELECT * FROM members WHERE userId = ?', [userId]);
        if (memberRows.length === 0) {
            return res.status(403).json({ message: "No library member profile found for this user." });
        }
        member = memberRows[0];
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
    
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const [books] = await connection.query('SELECT * FROM books WHERE id = ? AND available > 0 FOR UPDATE', [bookId]);
        const book = books[0];

        if (!book) {
            throw new Error('Book is unavailable.');
        }

        await connection.query('UPDATE books SET available = available - 1 WHERE id = ?', [bookId]);
        await connection.query('UPDATE members SET booksBorrowed = booksBorrowed + 1 WHERE id = ?', [member.id]);
        await connection.query(
            'INSERT INTO borrowed_records (bookId, memberId, bookTitle, memberName, borrowDate, dueDate) VALUES (?, ?, ?, ?, ?, ?)',
            [book.id, member.id, book.title, member.name, new Date().toISOString().split('T')[0], dueDate]
        );

        await connection.commit();
        res.status(201).json({ message: 'Book borrowed successfully!' });
    } catch (error) {
        await connection.rollback();
        console.error("Student Borrow Error:", error);
        res.status(500).json({ message: error.message || 'Failed to borrow book.' });
    } finally {
        connection.release();
    }
});

// --- ============================ ---
// --- BOOK ROUTES (SEARCH UPDATED) ---
// --- ============================ ---
app.get('/api/books', async (req, res) => {
    try {
        const { q } = req.query;
        let sql = 'SELECT id, title, author, isbn, genre, year, copies, available, coverImageURL FROM books';
        const params = [];
        if (q) {
            // --- UPDATED THIS SECTION ---
            sql += ' WHERE title LIKE ? OR author LIKE ? OR genre LIKE ? OR year LIKE ?';
            params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
            // --- END OF UPDATE ---
        }
        const [rows] = await db.query(sql, params);
        res.json(rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/books/:id', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM books WHERE id = ?', [req.params.id]);
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.status(404).json({ message: "Book not found" });
        }
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/books', async (req, res) => {
    try {
        const { title, author, isbn, genre, year, copies, coverImageURL } = req.body;
        if (!title || !author || !copies) {
             return res.status(400).json({ message: "Title, author, and copies are required." });
        }
        const [result] = await db.query(
            'INSERT INTO books (title, author, isbn, genre, year, copies, available, coverImageURL) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [title, author, isbn || null, genre || null, year || null, copies, copies, coverImageURL || null]
        );
        res.status(201).json({ id: result.insertId, title, author, isbn, genre, year, copies, available: copies, coverImageURL });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/books/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title, author, isbn, genre, year, copies, coverImageURL } = req.body;
        
        if (!title || !author || !copies) {
             return res.status(400).json({ message: "Title, author, and copies are required." });
        }

        const [rows] = await db.query('SELECT * FROM books WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: "Book not found" });
        }
        const oldBook = rows[0];

        const copyChange = (copies || oldBook.copies) - oldBook.copies;
        const newAvailable = oldBook.available + copyChange;

        if (newAvailable < 0) {
            return res.status(400).json({ message: "Cannot reduce copies below the number currently borrowed." });
        }
        
        const [result] = await db.query(
            'UPDATE books SET title = ?, author = ?, isbn = ?, genre = ?, year = ?, copies = ?, available = ?, coverImageURL = ? WHERE id = ?',
            [title, author, isbn || null, genre || null, year || null, copies, newAvailable, coverImageURL || null, id]
        );

        if (result.affectedRows > 0) {
            res.json({ message: "Book updated successfully." });
        } else {
            res.status(404).json({ message: "Book not found." });
        }
    } catch (err) {
        console.error("Book Update Error:", err);
        res.status(500).json({ message: err.message });
    }
});

app.delete('/api/books/:id', async (req, res) => {
    try {
        const [borrowed] = await db.query('SELECT 1 FROM borrowed_records WHERE bookId = ? LIMIT 1', [req.params.id]);
        if (borrowed.length > 0) {
            return res.status(400).json({ message: "Cannot delete a borrowed book." });
        }
        const [result] = await db.query('DELETE FROM books WHERE id = ?', [req.params.id]);
        if (result.affectedRows > 0) {
             res.status(204).send();
        } else {
             res.status(404).json({ message: "Book not found or already deleted." });
        }
    } catch (err) { res.status(500).json({ message: err.message }); }
});


// --- (All other routes remain the same) ---

// Member routes
app.get('/api/members', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, name, email, joinDate, booksBorrowed, outstandingFines FROM members');
        res.json(rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/members/:id/borrowed', async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT bookTitle, DATE_FORMAT(dueDate, "%Y-%m-%d") as dueDate FROM borrowed_records WHERE memberId = ?',
            [req.params.id]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/members', async (req, res) => {
    try {
        const { name, email } = req.body;
        if (!name) {
             return res.status(400).json({ message: "Name is required." });
        }
        const joinDate = new Date().toISOString().split('T')[0];
        const [result] = await db.query(
            'INSERT INTO members (name, email, joinDate) VALUES (?, ?, ?)',
            [name, email || null, joinDate]
        );
        res.status(201).json({ id: result.insertId, name, email, joinDate, booksBorrowed: 0, outstandingFines: 0 });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.put('/api/members/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email } = req.body;
        
        if (!name) {
             return res.status(400).json({ message: "Name is required." });
        }

        const [result] = await db.query(
            'UPDATE members SET name = ?, email = ? WHERE id = ?',
            [name, email || null, id]
        );

        if (result.affectedRows > 0) {
            res.json({ message: "Member updated successfully." });
        } else {
            res.status(404).json({ message: "Member not found." });
        }
    } catch (err) {
        console.error("Member Update Error:", err);
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/members/:id/pay-fines', async (req, res) => {
    try {
        const [result] = await db.query('UPDATE members SET outstandingFines = 0 WHERE id = ?', [req.params.id]);
         if (result.affectedRows > 0) {
             res.json({ message: 'Fines have been cleared.' });
         } else {
             res.status(404).json({ message: 'Member not found.'})
         }
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.delete('/api/members/:id', async (req, res) => {
    try {
        const [borrowed] = await db.query('SELECT 1 FROM borrowed_records WHERE memberId = ? LIMIT 1', [req.params.id]);
        if (borrowed.length > 0) {
            return res.status(400).json({ message: "Cannot delete member with borrowed books." });
        }
        const [result] = await db.query('DELETE FROM members WHERE id = ?', [req.params.id]);
        if (result.affectedRows > 0) {
            res.status(204).send();
        } else {
            res.status(404).json({ message: 'Member not found.'})
        }
    } catch (err) { res.status(500).json({ message: err.message }); }
});


// Borrowing routes
app.get('/api/borrowed', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, bookId, memberId, bookTitle, memberName, DATE_FORMAT(borrowDate, "%Y-%m-%d") as borrowDate, DATE_FORMAT(dueDate, "%Y-%m-%d") as dueDate FROM borrowed_records');
        res.json(rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

app.post('/api/borrow', async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const { memberId, bookId, dueDate } = req.body;
        const [books] = await connection.query('SELECT * FROM books WHERE id = ? AND available > 0 FOR UPDATE', [bookId]);
        const [members] = await connection.query('SELECT * FROM members WHERE id = ?', [memberId]);
        const book = books[0];
        const member = members[0];

        if (!book || !member) {
            throw new Error('Book is unavailable or member not found.');
        }

        await connection.query('UPDATE books SET available = available - 1 WHERE id = ?', [bookId]);
        await connection.query('UPDATE members SET booksBorrowed = booksBorrowed + 1 WHERE id = ?', [memberId]);
        await connection.query(
            'INSERT INTO borrowed_records (bookId, memberId, bookTitle, memberName, borrowDate, dueDate) VALUES (?, ?, ?, ?, ?, ?)',
            [book.id, member.id, book.title, member.name, new Date().toISOString().split('T')[0], dueDate]
        );

        await connection.commit();
        res.status(201).json({ message: 'Book borrowed successfully.' });
    } catch (error) {
        await connection.rollback();
        console.error("Borrow Error:", error);
        res.status(500).json({ message: error.message || 'Failed to borrow book.' });
    } finally {
        connection.release();
    }
});

app.post('/api/return', async (req, res) => {
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
        const { borrowId } = req.body;
        const [records] = await connection.query('SELECT * FROM borrowed_records WHERE id = ? FOR UPDATE', [borrowId]);
        const record = records[0];

        if (!record) { throw new Error('Borrow record not found.'); }

        const today = new Date(); today.setHours(0,0,0,0);
        const dueDate = new Date(record.dueDate);
        let fine = 0;
        let responseMessage = "Book returned successfully.";

        if (today > dueDate) {
            const timeDiff = today.getTime() - dueDate.getTime();
            const daysOverdue = Math.ceil(timeDiff / (1000 * 3600 * 24));
            fine = daysOverdue * DAILY_FINE_RATE;
            responseMessage += ` A fine of ₹${fine.toFixed(2)} for ${daysOverdue} day(s) overdue added.`;
        }

        await connection.query('UPDATE books SET available = available + 1 WHERE id = ?', [record.bookId]);
        await connection.query('UPDATE members SET booksBorrowed = booksBorrowed - 1, outstandingFines = outstandingFines + ? WHERE id = ?', [fine, record.memberId]);
        await connection.query('DELETE FROM borrowed_records WHERE id = ?', [borrowId]);

        await connection.commit();
        res.json({ message: responseMessage });
    } catch (error) {
        await connection.rollback();
        console.error("Return Error:", error);
        res.status(500).json({ message: error.message || 'Failed to return book.' });
    } finally {
        connection.release();
    }
});

// Stats route
app.get('/api/stats', async (req, res) => {
    try {
        const [[bookStats]] = await db.query('SELECT COUNT(*) as total, SUM(available) as available FROM books');
        const [[memberCount]] = await db.query('SELECT COUNT(*) as total FROM members');
        const [[borrowedCount]] = await db.query('SELECT COUNT(*) as total FROM borrowed_records');

        res.json({
            totalBooks: bookStats?.total || 0,
            availableBooks: bookStats?.available || 0,
            borrowedBooks: borrowedCount?.total || 0,
            totalMembers: memberCount?.total || 0,
        });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`📚 Library server (MySQL) running on http://localhost:${PORT}`);
});