import { randomUUID } from 'node:crypto'
import type SyncDatabase from '../sqlite/sync-database'
import {
  openVersionedCacheDatabase,
  removeVersionedCacheDatabase
} from '../sqlite/versioned-cache-database'

// The index stores transcript content as written, with no redaction. A secret in
// a transcript is already plaintext under the user's home directory and is
// treated as compromised; this is a second copy of content the user already
// holds. What a snippet may carry once it leaves this machine is a transport
// policy, decided where the wire is.

// Bump to drop and rebuild: the index is a cache over the transcripts, never a source.
export const SESSION_SEARCH_SCHEMA_VERSION = 6

// unicode61 keeps `_ . - /` inside tokens so paths and identifiers match exactly;
// the `identifiers` column carries the split form (see session-search-identifier-split).
// Why: `+` keeps `C++` a token of its own instead of the letter `c`; `#` is
// left out so `#123` still answers a search for `123`.
const TOKENIZER = `tokenize="unicode61 tokenchars '_.-/+'"`

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  -- AUTOINCREMENT, because this id names rows in the messages table for longer
  -- than the row itself lives: retention cuts a session loose in one
  -- transaction and reclaims its messages over many. A plain rowid is reissued
  -- as max+1, so a session created inside that window would be handed a freed
  -- id and adopt whatever of the purged conversation the drain had not reached,
  -- behind a live session no later purge visits.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  -- The transcript this session was decoded from. Not unique: OpenCode's SQLite
  -- sessions all report the store's own path here, while files.path holds the
  -- synthetic db#sessionId candidate that really is one per session.
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
  -- What this row still owes a reader, so that nothing has to be remembered
  -- between passes. 'current': the rows match the file at the stat recorded
  -- here. 'due': the index is behind on content it cannot reach by appending,
  -- so the next pass reads the file whole. 'failed': the last read did not
  -- commit, and the two columns below are what stop it being retried for ever.
  state TEXT NOT NULL DEFAULT 'current',
  fail_count INTEGER NOT NULL DEFAULT 0,
  -- The mtime the failures were observed at. A file that fails at one stat is
  -- left alone once it has failed enough times, and only a change to this stat
  -- can mean the file itself changed, so it is the whole retry policy.
  failed_mtime_ms REAL
);
-- Retention walks the expiring end of this column; without it that is a full scan and a sort.
CREATE INDEX IF NOT EXISTS files_mtime ON files(mtime_ms);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  session_row_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  ts TEXT
);
-- Both the replace delete and the orphan drain walk a session's rows through this.
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_row_id);
-- One FTS table, not two. A conversation-scoped search is a column filter on
-- this one — 'MATCH {user_text assistant_text}: q' with bm25 weights that zero
-- the other two — and PR 4 measured that at 1.16-1.36x the p95 of a dedicated
-- second table on a 105 MB corpus, under the 2x bar the decision was set at.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  user_text, assistant_text, tool_text, identifiers, ${TOKENIZER}, detail=full
);
`

/**
 * Opens the index, rebuilding it whenever what is on disk cannot be trusted
 * (see openVersionedCacheDatabase): the index is a cache over the transcripts.
 */
export function openSessionSearchDatabase(path: string): SyncDatabase {
  return openVersionedCacheDatabase(path, {
    version: SESSION_SEARCH_SCHEMA_VERSION,
    sql: SCHEMA_SQL,
    afterSchema: (db) =>
      db
        .prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)')
        .run('index_incarnation', randomUUID())
  })
}

export function removeSessionSearchDatabase(path: string): void {
  removeVersionedCacheDatabase(path)
}
