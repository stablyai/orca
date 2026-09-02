import SyncDatabase from '../sqlite/sync-database'

// Bump to drop and rebuild: the index is a cache over the transcripts, never a source.
export const SESSION_SEARCH_SCHEMA_VERSION = 2

// unicode61 keeps `_ . - /` inside tokens so paths and identifiers match exactly;
// the `identifiers` column carries the split form (see session-search-identifier-split).
const TOKENIZER = `tokenize="unicode61 tokenchars '_.-/'"`

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  -- Not unique: OpenCode/Cursor SQLite sessions share one store path; files.path is the key.
  file_path TEXT NOT NULL,
  codex_home TEXT,
  title TEXT NOT NULL,
  cwd TEXT,
  branch TEXT,
  created_at TEXT,
  updated_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  resume_command TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at);
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY,
  dev INTEGER,
  ino INTEGER,
  byte_offset INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER,
  session_row_id INTEGER
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  session_row_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  ts TEXT
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_row_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  user_text, assistant_text, tool_text, identifiers, ${TOKENIZER}, detail=full
);
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
  user_text, assistant_text, ${TOKENIZER}, detail=full
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_vocab USING fts5vocab(messages_fts, 'row');
CREATE TABLE IF NOT EXISTS search_log(
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  query TEXT NOT NULL,
  route TEXT NOT NULL,
  hits INTEGER NOT NULL,
  duration_ms REAL NOT NULL
);
`

const DROP_SQL = `
DROP TABLE IF EXISTS messages_vocab;
DROP TABLE IF EXISTS conversation_fts;
DROP TABLE IF EXISTS messages_fts;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS search_log;
DROP TABLE IF EXISTS meta;
`

export function openSessionSearchDatabase(path: string): SyncDatabase {
  const db = new SyncDatabase(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  const version = readSchemaVersion(db)
  if (version !== null && version !== SESSION_SEARCH_SCHEMA_VERSION) {
    db.exec(DROP_SQL)
  }
  db.exec(SCHEMA_SQL)
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SESSION_SEARCH_SCHEMA_VERSION)
  )
  return db
}

export function openSessionSearchDatabaseReadOnly(path: string): SyncDatabase {
  const db = new SyncDatabase(path, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 1500')
  return db
}

function readSchemaVersion(db: SyncDatabase): number | null {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get()
  if (!table) {
    return null
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined
  const parsed = row ? Number(row.value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}
