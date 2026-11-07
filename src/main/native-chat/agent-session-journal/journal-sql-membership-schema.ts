export function journalSqlMembershipSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_provider_input_groups (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, provider_item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_provider_input_groups_order
  ON journal_proj_provider_input_groups(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_dispatch_fence_groups (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  fence REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, fence)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_dispatch_fence_groups_order
  ON journal_proj_dispatch_fence_groups(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_signed_out_groups (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  fence REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, fence)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_signed_out_groups_order
  ON journal_proj_signed_out_groups(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_kept_card_groups (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_kept_card_groups_order
  ON journal_proj_kept_card_groups(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_steer_groups (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, turn_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_steer_groups_order
  ON journal_proj_steer_groups(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_coverage_groups (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_coverage_groups_order
  ON journal_proj_coverage_groups(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_link_families (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  family_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, family_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_link_families_order
  ON journal_proj_link_families(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_signed_out_inputs (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  fence REAL NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, fence, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_signed_out_inputs_order
  ON journal_proj_signed_out_inputs(session_id, epoch, fence, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_signed_out_inputs_counters (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  fence REAL NOT NULL,
  members_count INTEGER NOT NULL DEFAULT 0,
  members_ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, epoch, fence)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS journal_proj_kept_card_inputs (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, message_id, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_kept_card_inputs_order
  ON journal_proj_kept_card_inputs(session_id, epoch, message_id, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_kept_card_inputs_counters (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  members_count INTEGER NOT NULL DEFAULT 0,
  members_ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, epoch, message_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS journal_proj_input_coverers (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  carrier_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id, carrier_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_input_coverers_order
  ON journal_proj_input_coverers(session_id, epoch, input_id, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_input_coverers_counters (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  members_count INTEGER NOT NULL DEFAULT 0,
  members_ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS journal_proj_phase_members (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  phase TEXT NOT NULL,
  input_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  submission_id TEXT,
  submission_incarnation INTEGER,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, phase, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_phase_members_order
  ON journal_proj_phase_members(session_id, epoch, phase, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_phase_members_counters (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  phase TEXT NOT NULL,
  members_count INTEGER NOT NULL DEFAULT 0,
  members_ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, epoch, phase)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS journal_proj_link_family_members (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  family_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  submission_id TEXT,
  submission_incarnation INTEGER,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, family_id, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_link_family_members_order
  ON journal_proj_link_family_members(session_id, epoch, family_id, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_link_family_members_counters (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  family_id TEXT NOT NULL,
  members_count INTEGER NOT NULL DEFAULT 0,
  members_ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, epoch, family_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS journal_proj_index_cards (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  index_name TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  payload_json TEXT,
  card_id TEXT,
  card_incarnation INTEGER,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, index_name, entry_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_index_cards_order
  ON journal_proj_index_cards(session_id, epoch, index_name, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_index_cards_counters (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  index_name TEXT NOT NULL,
  members_count INTEGER NOT NULL DEFAULT 0,
  members_ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, epoch, index_name)
) WITHOUT ROWID;
`
}
