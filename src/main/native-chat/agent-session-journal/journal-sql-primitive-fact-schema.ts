export function journalSqlPrimitiveFactSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_aliases (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  alias TEXT NOT NULL,
  target TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, alias)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_aliases_order ON journal_proj_aliases(session_id, epoch, ordinal);
CREATE INDEX IF NOT EXISTS journal_proj_aliases_target ON journal_proj_aliases(session_id, epoch, target, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_item_fences (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  fence REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_item_fences_order ON journal_proj_item_fences(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_item_execution_owners (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  fence REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_item_execution_owners_order ON journal_proj_item_execution_owners(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_provider_activity (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  fence REAL NOT NULL,
  observed_at REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, fence)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_provider_activity_order ON journal_proj_provider_activity(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_tombstones (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_tombstones_order ON journal_proj_tombstones(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_removed_turns (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, turn_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_removed_turns_order ON journal_proj_removed_turns(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_settlements (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  settlement_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, settlement_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_settlements_order ON journal_proj_settlements(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_normalized_handoffs (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_normalized_handoffs_order ON journal_proj_normalized_handoffs(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_item_echoes (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_item_echoes_order ON journal_proj_item_echoes(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_stopped_carried (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_stopped_carried_order ON journal_proj_stopped_carried(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_handoff_places (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_handoff_places_order ON journal_proj_handoff_places(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_original_acceptances (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_original_acceptances_order ON journal_proj_original_acceptances(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_carrier_coverage (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_carrier_coverage_order ON journal_proj_carrier_coverage(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_link_ids (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_link_ids_order ON journal_proj_link_ids(session_id, epoch, ordinal);
`
}
