-- Regenerate: rm -f sample-database.db && sqlite3 sample-database.db < sample-database.sql
PRAGMA page_size = 512;

CREATE TABLE people (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    score   REAL,
    data    BLOB,
    note    TEXT
);

CREATE TABLE "odd names" (
    "select"   TEXT,
    [group by] INTEGER,
    `limit`    TEXT
);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT
) WITHOUT ROWID;

INSERT INTO people (id, name, score, data, note) VALUES
    (1, 'Ada', 99.5, x'0102030405', NULL),
    (2, 'Grace', NULL, NULL, 'unicode: héllo wörld ✅'),
    (3, 'Alan', -0.25, x'ff', '');

INSERT INTO people (id, name, score, data, note)
VALUES (4, 'Overflow', 1.0, NULL, replace(hex(zeroblob(3000)), '0', 'x'));

WITH RECURSIVE seq(n) AS (SELECT 100 UNION ALL SELECT n + 1 FROM seq WHERE n < 400)
INSERT INTO people (id, name, score, data, note)
SELECT n, 'person-' || n, n / 4.0, NULL, 'row ' || n FROM seq;

INSERT INTO "odd names" VALUES ('a', 1, 'b');

CREATE TABLE generated (
    a    INTEGER,
    virt AS (a + 1),
    stor GENERATED ALWAYS AS (a * 2) STORED,
    z    TEXT
);
INSERT INTO generated (a, z) VALUES (10, 'ten'), (20, 'twenty');

CREATE TABLE altered (a INTEGER);
INSERT INTO altered VALUES (1), (2);
ALTER TABLE altered ADD COLUMN added TEXT DEFAULT 'from-default';
ALTER TABLE altered ADD COLUMN n INTEGER DEFAULT 42;

CREATE TABLE table_key (id INTEGER, label TEXT, PRIMARY KEY (id));
INSERT INTO table_key VALUES (7, 'seven'), (9, 'nine');

CREATE TABLE "without rowid" (x TEXT DEFAULT 'without rowid');
INSERT INTO "without rowid" VALUES ('present');

CREATE TABLE autoinc (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
INSERT INTO autoinc (v) VALUES ('a');

CREATE VIRTUAL TABLE docs USING fts5(title, body);
INSERT INTO docs VALUES ('first', 'hello world');

CREATE TABLE docs_archive (note TEXT);
INSERT INTO docs_archive VALUES ('kept');

INSERT INTO settings VALUES ('theme', 'dark'), ('locale', 'nl');
