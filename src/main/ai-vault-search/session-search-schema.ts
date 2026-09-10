import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'

// The index stores transcript content as written, with no redaction. A secret in
// a transcript is already plaintext under the user's home directory and is
// treated as compromised; this is a second copy of content the user already
// holds. What a snippet may carry once it leaves this machine is a transport
// policy, decided where the wire is.

// Bump to drop and rebuild: the index is a cache over the transcripts, never a source.
export const SESSION_SEARCH_SCHEMA_VERSION = 3

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
  session_row_id INTEGER
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
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  user_text, assistant_text, tool_text, identifiers, ${TOKENIZER}, detail=full
);
CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
  user_text, assistant_text, ${TOKENIZER}, detail=full
);
`

/**
 * Opens the index, rebuilding it whenever what is on disk cannot be trusted:
 * a different schema version, a version SQLite cannot report, or a file torn
 * badly enough that opening or recovery fails. The index is a cache over the
 * transcripts, so throwing away a bad one costs a re-scan and nothing else;
 * refusing to open would strand the feature until a human deleted the file.
 */
export function openSessionSearchDatabase(path: string): SyncDatabase {
  // SQLite will not create the directory, and its failure is `unable to open
  // database file`, which is correctly not corruption — so without this the
  // feature strands on a profile that has never held an index.
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  try {
    return openExisting(path)
  } catch (error) {
    if (!isUnusableDatabaseError(error)) {
      throw error
    }
    // One retry only: a second failure on a file we just created is not corruption.
    removeSessionSearchDatabase(path)
    return openExisting(path)
  }
}

function openExisting(path: string): SyncDatabase {
  // Nulled while no handle is open, because closing an already-closed handle
  // throws ERR_INVALID_STATE, which would replace whatever really failed —
  // an unlink refused by a virus scanner or a second Orca holding the file —
  // with an error nothing classifies as worth rebuilding for.
  let db: SyncDatabase | null = openWithPragmas(path)
  try {
    if (isStaleSchema(db)) {
      // Why: DROP TABLE on a multi-GB FTS index takes minutes and runs inside the
      // scanner service's init, past its ready timeout; unlinking is instant.
      db.close()
      db = null
      removeSessionSearchDatabase(path)
      db = openWithPragmas(path)
    }
    db.exec(SCHEMA_SQL)
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SESSION_SEARCH_SCHEMA_VERSION)
    )
    return db
  } catch (error) {
    db?.close()
    throw error
  }
}

// SQLite reports a torn file at the first statement that has to read a page, so
// this has to match on the message as well as the code.
const UNUSABLE_DATABASE =
  /SQLITE_CORRUPT|SQLITE_NOTADB|file is not a database|database disk image is malformed/i

function isUnusableDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as { code?: unknown }).code
  return (
    (typeof code === 'string' && UNUSABLE_DATABASE.test(code)) ||
    UNUSABLE_DATABASE.test(error.message)
  )
}

function openWithPragmas(path: string): SyncDatabase {
  const db = new SyncDatabase(path)
  try {
    // Why: only takes effect on an empty file; it is what lets a purge hand pages
    // back in bounded steps instead of a full VACUUM. Set before any table exists.
    db.pragma('auto_vacuum = INCREMENTAL')
    // The whole consistency model: a file's rows and its cursor land in one
    // transaction, and a reader on another handle sees the last committed state
    // of the index rather than a session half way through being rewritten.
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('journal_size_limit = 8388608')
    db.pragma('busy_timeout = 5000')
    return db
  } catch (error) {
    db?.close()
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

/**
 * Whether what is on disk has to be thrown away. No `meta` table at all is a
 * file with nothing in it to throw away, and removing it would make the first
 * open of every new profile a create-remove-create. A meta table whose version
 * row is missing or unparseable is a damaged index rather than a new one:
 * seeding the current version over it would keep whatever rows the old schema
 * left.
 */
function isStaleSchema(db: SyncDatabase): boolean {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get()
  if (!table) {
    return false
  }
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined
  return (row ? Number(row.value) : Number.NaN) !== SESSION_SEARCH_SCHEMA_VERSION
}
