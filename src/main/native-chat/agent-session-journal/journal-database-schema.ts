// Table shape for one session's journal database.
//
// `journal_rows` is the append-only log; `journal_sessions` is the derived
// projection, upserted in the SAME transaction as every row insert so the live
// epoch and the rows that belong to it can never disagree. `journal_repairs`
// carries at most one row per session: the standing demand for a rebuild a
// partial repair leaves behind (see journal-repair-marker.ts).

/** DB shape (`PRAGMA user_version`) and row body versions evolve independently.
 *  v3 adds immutable materialization identity for conditional historical repair.
 *  v2 added `journal_repairs`; a build without it would replay a partially
 *  repaired journal as clean, so it must latch read-only rather than write. */
export const JOURNAL_DB_SCHEMA_VERSION = 3

export function createJournalTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_materialization (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  incarnation TEXT NOT NULL
);
INSERT OR IGNORE INTO journal_materialization VALUES (1, lower(hex(randomblob(16))));
CREATE TABLE IF NOT EXISTS journal_rows (
  session_id TEXT    NOT NULL,
  epoch      TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  row_json   TEXT    NOT NULL,
  PRIMARY KEY (session_id, epoch, seq)
);
CREATE TABLE IF NOT EXISTS journal_sessions (
  session_id TEXT PRIMARY KEY,
  epoch      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_repairs (
  session_id   TEXT PRIMARY KEY,
  epoch        TEXT    NOT NULL,
  content_from INTEGER NOT NULL,
  repaired_at  INTEGER NOT NULL
);
`
}
