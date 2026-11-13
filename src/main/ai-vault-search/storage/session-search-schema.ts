import { removeTree } from '../../../shared/windows-transient-lock-removal'
import { randomUUID } from 'node:crypto'
import type SyncDatabase from '../../sqlite/sync-database'
import { openVersionedCacheDatabase } from '../../sqlite/versioned-cache-database'
import { asRecord } from '../../ai-vault/parsing/session-record-fields'

// Cache transcript content verbatim; outbound snippet policy belongs at the transport boundary.

// Bump to discard and rebuild this transcript-derived cache.
export const SESSION_SEARCH_SCHEMA_VERSION = 8

// Keep paths and C++ intact; omit # so #123 also matches 123.
const TOKENIZER = `tokenize="unicode61 tokenchars '_.-/+'"`

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  -- Never reuse IDs while orphaned messages may still reference the deleted session.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  -- OpenCode sessions share a store path here; files.path holds the unique synthetic candidate.
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
CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS sessions_cwd_key ON sessions(cwd_key);
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY,
  dev INTEGER,
  ino INTEGER,
  byte_offset INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  size_bytes INTEGER,
  session_row_id INTEGER,
  -- current covers the recorded stat; due needs a whole read; failed did not commit.
  state TEXT NOT NULL DEFAULT 'current',
  fail_count INTEGER NOT NULL DEFAULT 0,
  -- Retry held-out failures only after the source mtime changes.
  failed_mtime_ms REAL,
  -- SHA-256 of bytes [0, byte_offset); lets a reread after restart append instead of replace.
  prefix_hash TEXT,
  -- Stat of the sidecar that supplied messages, so an append there is not missed when the
  -- metadata file this row was keyed on stays untouched.
  sidecar_mtime_ms REAL,
  sidecar_size_bytes INTEGER
);
CREATE INDEX IF NOT EXISTS files_mtime ON files(mtime_ms);
CREATE INDEX IF NOT EXISTS files_session_mtime ON files(session_row_id, mtime_ms);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  session_row_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  ts TEXT,
  text_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_row_id);
-- Conversation scope filters user/assistant columns within this table.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  user_text, assistant_text, tool_text, identifiers, ${TOKENIZER}, detail=full
);
`

/** Open the versioned cache, rebuilding it whenever a schema change invalidates old rows. */
export function openSessionSearchDatabase(path: string): SyncDatabase {
  return openVersionedCacheDatabase(path, {
    version: SESSION_SEARCH_SCHEMA_VERSION,
    sql: SCHEMA_SQL,
    afterSchema: (db) => {
      db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run(
        'index_incarnation',
        randomUUID()
      )
      db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run(
        'index_maintenance_generation',
        '0'
      )
      // Each small commit adds an FTS segment; wider merges mean fewer levels rewriting it (#36666).
      db.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES ('automerge', 8)").run()
      // Older Cursor rows omitted the file-time fallback; repair metadata without rereading transcripts.
      db.exec(`
        UPDATE sessions SET updated_at = (
          SELECT strftime('%Y-%m-%dT%H:%M:%fZ', CAST(files.mtime_ms AS INTEGER) / 1000.0, 'unixepoch')
          FROM files WHERE files.path = sessions.file_path AND files.session_row_id = sessions.id
        )
        WHERE agent = 'cursor' AND updated_at IS NULL
          AND EXISTS (SELECT 1 FROM files WHERE files.path = sessions.file_path
            AND files.session_row_id = sessions.id)
      `)
      addSessionSearchPrefixHashColumn(db)
      addSessionSearchSidecarStatColumns(db)
    }
  })
}

/** Version 8 indexes predate the column; check under the write lock so concurrent openers add it once. */
export function addSessionSearchPrefixHashColumn(db: SyncDatabase): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const columns = db.prepare('PRAGMA table_info(files)').all()
    if (!columns.some((column) => asRecord(column)?.name === 'prefix_hash')) {
      db.exec('ALTER TABLE files ADD COLUMN prefix_hash TEXT')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Version 8 indexes predate the columns; rows read back as null, which misses on the next sidecar. */
export function addSessionSearchSidecarStatColumns(db: SyncDatabase): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const columns = db.prepare('PRAGMA table_info(files)').all()
    const names = new Set(columns.map((column) => asRecord(column)?.name))
    if (!names.has('sidecar_mtime_ms')) {
      db.exec('ALTER TABLE files ADD COLUMN sidecar_mtime_ms REAL')
    }
    if (!names.has('sidecar_size_bytes')) {
      db.exec('ALTER TABLE files ADD COLUMN sidecar_size_bytes INTEGER')
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Async lock retries keep scanner/server deadlines responsive after all workers have retired. */
export async function removeSessionSearchDatabaseAsync(path: string): Promise<void> {
  if (path === ':memory:') {
    return
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    await removeTree(`${path}${suffix}`)
  }
}
