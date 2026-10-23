// Table shape for the host's one chat journal database.
//
// `journal_rows` is every chat's append-only log, keyed `(session_id, epoch, seq)`.
// `journal_sessions` names each chat's live epoch and its open root turn. It is written when the
// epoch changes and when a root turn opens or finishes, so a streamed append is one INSERT, and a
// restart reads whether a chat was cut mid-turn without reading its rows. `journal_repairs`,
// `journal_imports` and `journal_set_aside` are only for builds before version 5, which this build
// neither reads nor writes. The `agent_session_*` tables hold each chat's ownership record, its
// operation ledger, the retired claim keys and the chat tab index (agent-session-record-rows.ts).

import type Database from '../../sqlite/sync-database'

/** DB shape version, carried in `PRAGMA user_version`. Independent of the row body version
 *  (`JournalRow.v`): a newer build can change either alone. A newer version is opened read-only here
 *  and its chats are refused as a newer Orca's, so every change stays additive. */
export const JOURNAL_DB_SCHEMA_VERSION = 5

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

/** Version 5: each chat's open root turn — the turn record's journal key and when it started —
 *  set and cleared in the transaction of the row that opens or finishes it. A turn a stop cut short
 *  stays open: only a turn that finished on its own clears it. */
export function addJournalOpenTurnColumns(db: Database.Database): void {
  // A file stamped below its shape (a crash between the DDL and the stamp) may already have them.
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(journal_sessions)')
      .all()
      .map(({ name }) => name)
  )
  for (const [name, type] of [
    ['open_turn_id', 'TEXT'],
    ['open_turn_since', 'INTEGER']
  ]) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE journal_sessions ADD COLUMN ${name} ${type}`)
    }
  }
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
