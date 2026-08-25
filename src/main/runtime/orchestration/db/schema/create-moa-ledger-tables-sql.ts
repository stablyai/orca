// MoA (Mixture of Agents) deliberation ledger: append-only audit tables.
// Design invariants (do not regress):
// - No SQL CHECK enums: SQLite cannot ALTER a CHECK; entry kinds/verdicts are validated in TypeScript.
// - Strict append-only: outcomes/closes are new rows referencing earlier rows, never UPDATEs.
// - Entry ids are content-addressed; ingest uses INSERT OR IGNORE so replays and duplicate sends are no-ops.
// - Display order is (round, authored_at, id); rowid is exposed only as a local pagination cursor —
//   federated entries arrive in relay order, not author order.
export function createMoaLedgerTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS moa_deliberations (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  task_id      TEXT,
  seat_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_moa_deliberations_run ON moa_deliberations(run_id);

CREATE TABLE IF NOT EXISTS moa_ledger_entries (
  id               TEXT PRIMARY KEY,
  deliberation_id  TEXT NOT NULL,
  round            INTEGER NOT NULL DEFAULT 1,
  entry_kind       TEXT NOT NULL,
  seat_id          TEXT,
  subject_entry_id TEXT,
  verdict          TEXT,
  rationale        TEXT,
  payload          TEXT NOT NULL DEFAULT '{}',
  message_id       TEXT,
  authored_at      TEXT,
  recorded_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_moa_entries_display
  ON moa_ledger_entries(deliberation_id, round, authored_at, id);
  `
}
