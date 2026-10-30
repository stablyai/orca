// Keep legacy repair/import/set-aside tables for older clients using the same schema version.

/** Database version is independent of row versions; newer databases must remain read-only. */
export const JOURNAL_DB_SCHEMA_VERSION = 5

// Versions 1–2 existed only in unreleased builds.
export const JOURNAL_DB_OLDEST_RELEASED_VERSION = 3

export function createJournalTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_rows (
  session_id TEXT    NOT NULL,
  epoch      TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  row_json   TEXT    NOT NULL,
  PRIMARY KEY (session_id, epoch, seq)
);
CREATE TABLE IF NOT EXISTS journal_sessions (
  session_id   TEXT PRIMARY KEY,
  workspace_id TEXT    NOT NULL,
  epoch        TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_repairs (
  session_id   TEXT PRIMARY KEY,
  epoch        TEXT    NOT NULL,
  content_from INTEGER NOT NULL,
  repaired_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_imports (
  session_id TEXT PRIMARY KEY,
  epoch      TEXT    NOT NULL,
  tip        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_set_aside (
  session_id TEXT PRIMARY KEY,
  epoch      TEXT    NOT NULL,
  tip        INTEGER NOT NULL
);
`
}

// JSON rows preserve unreadable records byte-for-byte.
export function createAgentSessionRecordTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS agent_session_records (
  session_id  TEXT PRIMARY KEY,
  record_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_session_operations (
  operation_key TEXT PRIMARY KEY,
  row_json      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_session_retired_claim_keys (
  key_id     TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_session_tabs (
  tab_id     TEXT PRIMARY KEY,
  session_id TEXT    NOT NULL,
  position   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_session_store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
}
