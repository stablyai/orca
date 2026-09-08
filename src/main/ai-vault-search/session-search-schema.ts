import SyncDatabase from '../sqlite/sync-database'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'

// Bump to drop and rebuild: the index is a cache over the transcripts, never a source.
export const SESSION_SEARCH_SCHEMA_VERSION = 11

// unicode61 keeps `_ . - /` inside tokens so paths and identifiers match exactly;
// the `identifiers` column carries the split form (see session-search-identifier-split).
// Why: `+` keeps `C++` a token of its own instead of the letter `c`; `#` is
// left out so `#123` still answers a search for `123`.
const TOKENIZER = `tokenize="unicode61 tokenchars '_.-/+'"`

/** Sessions and messages a read may return: published, not tombstoned. */
export const VISIBLE_SESSIONS = 'visible_sessions'
export const VISIBLE_MESSAGES = 'visible_messages'

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  index_ready INTEGER NOT NULL DEFAULT 1,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  -- Not unique: OpenCode/Cursor SQLite sessions share one store path; files.path is the key.
  file_path TEXT NOT NULL,
  codex_home TEXT,
  title TEXT NOT NULL,
  cwd TEXT,
  cwd_key TEXT,
  branch TEXT,
  created_at TEXT,
  updated_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  resume_command TEXT NOT NULL,
  -- Chained digest of the first N messages; forks of one conversation share it.
  content_hash TEXT,
  content_hash_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS sessions_content_hash ON sessions(content_hash);
CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS sessions_cwd_key ON sessions(cwd_key);
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY,
  dev INTEGER,
  ino INTEGER,
  byte_offset INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER,
  session_row_id INTEGER
);
CREATE TABLE IF NOT EXISTS search_pending_deletes(
  path TEXT PRIMARY KEY,
  session_row_id INTEGER NOT NULL,
  batch_id INTEGER
);
-- A row exists only while its batch is in flight; publish clears its messages and deletes it.
CREATE TABLE IF NOT EXISTS search_write_batches(
  id INTEGER PRIMARY KEY,
  session_row_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS search_write_batches_session ON search_write_batches(session_row_id);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  session_row_id INTEGER NOT NULL,
  batch_id INTEGER,
  role TEXT NOT NULL,
  ts TEXT
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_row_id);
-- Partial: publish nulls batch_id, so all but the in-flight rows would be dead entries.
CREATE INDEX IF NOT EXISTS messages_batch ON messages(batch_id) WHERE batch_id IS NOT NULL;
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
-- Why: staged rows must never reach a result. One definition per half, so a new
-- read site cannot forget one; SQLite flattens both into the caller's plan.
CREATE VIEW IF NOT EXISTS ${VISIBLE_SESSIONS} AS SELECT * FROM sessions
  WHERE index_ready = 1
    AND id NOT IN (SELECT session_row_id FROM search_pending_deletes WHERE batch_id IS NULL);
CREATE VIEW IF NOT EXISTS ${VISIBLE_MESSAGES} AS SELECT * FROM messages
  WHERE batch_id IS NULL;
`

export function openSessionSearchDatabase(path: string): SyncDatabase {
  let db = openWithPragmas(path)
  const version = readSchemaVersion(db)
  if (version !== null && version !== SESSION_SEARCH_SCHEMA_VERSION) {
    // Why: DROP TABLE on a multi-GB FTS index takes minutes and runs inside the
    // scanner service's init, past its ready timeout; unlinking is instant.
    db.close()
    removeSessionSearchDatabase(path)
    db = openWithPragmas(path)
  }
  db.exec(SCHEMA_SQL)
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SESSION_SEARCH_SCHEMA_VERSION)
  )
  return db
}

function openWithPragmas(path: string): SyncDatabase {
  const db = new SyncDatabase(path)
  try {
    // Why: only takes effect on an empty file; it is what lets a purge hand pages
    // back in bounded steps instead of a full VACUUM. Set before any table exists.
    db.pragma('auto_vacuum = INCREMENTAL')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('journal_size_limit = 8388608')
    db.pragma('busy_timeout = 5000')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function removeSessionSearchDatabase(path: string): void {
  if (path === ':memory:') {
    return
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    removeTreeSync(`${path}${suffix}`)
  }
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
