export function journalSqlInputObservationSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_returned_commands (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_returned_commands_order
  ON journal_proj_returned_commands(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_input_echoes (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_input_echoes_order
  ON journal_proj_input_echoes(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_ended_inputs (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_ended_inputs_order
  ON journal_proj_ended_inputs(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_recovery_owed (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_recovery_owed_order
  ON journal_proj_recovery_owed(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_unintroduced_cards (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_unintroduced_cards_order
  ON journal_proj_unintroduced_cards(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_cleared_cards (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_cleared_cards_order
  ON journal_proj_cleared_cards(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_input_providers (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_input_providers_order
  ON journal_proj_input_providers(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_observed_input_ids (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_key TEXT NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, item_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_observed_input_ids_order
  ON journal_proj_observed_input_ids(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_input_dispatch_fences (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  fence REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_input_dispatch_fences_order
  ON journal_proj_input_dispatch_fences(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_recovered_unknown_inputs (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_recovered_unknown_inputs_order
  ON journal_proj_recovered_unknown_inputs(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_submission_row_winners (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  sequence REAL NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, sequence)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_submission_row_winners_order
  ON journal_proj_submission_row_winners(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_submission_row_coordinates (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  sequence REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_submission_row_coordinates_order
  ON journal_proj_submission_row_coordinates(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_kept_input_cards (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_kept_input_cards_order
  ON journal_proj_kept_input_cards(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_input_ordinals (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  input_ordinal REAL NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_input_ordinals_order
  ON journal_proj_input_ordinals(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_steer_turns (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_steer_turns_order
  ON journal_proj_steer_turns(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_stopped_candidates (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, input_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_stopped_candidates_order
  ON journal_proj_stopped_candidates(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_latest_family_members (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  family_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, family_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_latest_family_members_order
  ON journal_proj_latest_family_members(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_turn_failure_reports (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  target_item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_turn_failure_reports_order
  ON journal_proj_turn_failure_reports(session_id, epoch, ordinal);
CREATE TABLE IF NOT EXISTS journal_proj_turn_failure_report_counts (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  target_item_id TEXT NOT NULL,
  report_count INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (session_id, epoch, target_item_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_turn_failure_report_counts_order
  ON journal_proj_turn_failure_report_counts(session_id, epoch, ordinal);
`
}
