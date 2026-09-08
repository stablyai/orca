// Table shape for one session's journal database.
//
// `journal_rows` is the append-only log; `journal_sessions` is the derived
// projection, upserted in the SAME transaction as every row insert so the live
// epoch and the rows that belong to it can never disagree. `journal_repairs`
// carries at most one row per session: the standing demand for a rebuild a
// partial repair leaves behind (see journal-repair-marker.ts).

/** DB shape version, carried in `PRAGMA user_version`. Independent of the row
 *  body version (`JournalRow.v`): a newer build can change either alone.
 *  v2 added `journal_repairs`; a build without it would replay a partially
 *  repaired journal as clean, so it must latch read-only rather than write. */
export const JOURNAL_DB_SCHEMA_VERSION = 3

// v3 seals recovery epochs; older hosts must not delete them during rollover.
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
CREATE TABLE IF NOT EXISTS journal_recovery_epochs (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  replacement_epoch TEXT NOT NULL,
  rejected_from INTEGER NOT NULL,
  prefix_through INTEGER NOT NULL,
  sealed_at INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  row_bytes INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch)
);
CREATE TRIGGER IF NOT EXISTS journal_sealed_row_insert BEFORE INSERT ON journal_rows
WHEN EXISTS (SELECT 1 FROM journal_recovery_epochs WHERE session_id = NEW.session_id AND epoch = NEW.epoch)
BEGIN SELECT RAISE(ABORT, 'journal epoch is sealed'); END;
CREATE TRIGGER IF NOT EXISTS journal_sealed_row_update BEFORE UPDATE ON journal_rows
WHEN EXISTS (SELECT 1 FROM journal_recovery_epochs
  WHERE (session_id = OLD.session_id AND epoch = OLD.epoch)
     OR (session_id = NEW.session_id AND epoch = NEW.epoch))
BEGIN SELECT RAISE(ABORT, 'journal epoch is sealed'); END;
CREATE TRIGGER IF NOT EXISTS journal_sealed_row_delete BEFORE DELETE ON journal_rows
WHEN EXISTS (SELECT 1 FROM journal_recovery_epochs WHERE session_id = OLD.session_id AND epoch = OLD.epoch)
BEGIN SELECT RAISE(ABORT, 'journal epoch is sealed'); END;
CREATE TRIGGER IF NOT EXISTS journal_recovery_epoch_update BEFORE UPDATE ON journal_recovery_epochs
BEGIN SELECT RAISE(ABORT, 'journal recovery evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS journal_recovery_epoch_delete BEFORE DELETE ON journal_recovery_epochs
BEGIN SELECT RAISE(ABORT, 'journal recovery evidence is immutable'); END;
`
}
