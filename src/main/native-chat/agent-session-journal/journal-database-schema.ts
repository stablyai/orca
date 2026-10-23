// Table shape for the host's one chat journal database.
//
// `journal_rows` is every chat's append-only log, keyed `(session_id, epoch, seq)`.
// `journal_sessions` names each chat's live epoch, and is written only when that epoch changes, so
// an append is one INSERT. `journal_repairs`, `journal_imports` and `journal_set_aside` are only
// for an older build, which reads and writes them on this same schema version; this build does
// neither. The `agent_session_*` tables hold each chat's ownership record, its operation ledger,
// the retired claim keys and the chat tab index (agent-session-record-rows.ts).

/** DB shape version, carried in `PRAGMA user_version`. Independent of the row body version
 *  (`JournalRow.v`): a newer build can change either alone. A newer version is opened read-only here
 *  and its chats are refused as a newer Orca's, so every change stays additive. */
export const JOURNAL_DB_SCHEMA_VERSION = 4

/** The first version a release wrote; 1 and 2 only ever came from development builds. */
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

/** Version 4: the chat records. Each row is one JSON value, so a row this build cannot read stays
 *  byte-identical. */
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
