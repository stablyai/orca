import { randomUUID } from 'node:crypto'
import type SyncDatabase from '../sqlite/sync-database'
import {
  openVersionedCacheDatabase,
  removeVersionedCacheDatabase
} from '../sqlite/versioned-cache-database'

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
  failed_mtime_ms REAL
);
CREATE INDEX IF NOT EXISTS files_mtime ON files(mtime_ms);
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

export function openSessionSearchDatabase(path: string): SyncDatabase {
  return openVersionedCacheDatabase(path, {
    version: SESSION_SEARCH_SCHEMA_VERSION,
    sql: SCHEMA_SQL,
    afterSchema: (db) => {
      db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run(
        'index_incarnation',
        randomUUID()
      )
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
    }
  })
}

export function removeSessionSearchDatabase(path: string): void {
  removeVersionedCacheDatabase(path)
}
