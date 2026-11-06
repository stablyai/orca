export function journalSqlInputEntitySchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_input_entity_counters (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  submissions_count INTEGER NOT NULL DEFAULT 0,
  submissions_ordinal INTEGER NOT NULL DEFAULT 0,
  submissions_incarnation INTEGER NOT NULL DEFAULT 0,
  receipts_count INTEGER NOT NULL DEFAULT 0,
  receipts_ordinal INTEGER NOT NULL DEFAULT 0,
  receipts_incarnation INTEGER NOT NULL DEFAULT 0,
  cards_count INTEGER NOT NULL DEFAULT 0,
  cards_ordinal INTEGER NOT NULL DEFAULT 0,
  cards_incarnation INTEGER NOT NULL DEFAULT 0,
  entries_count INTEGER NOT NULL DEFAULT 0,
  entries_ordinal INTEGER NOT NULL DEFAULT 0,
  entries_incarnation INTEGER NOT NULL DEFAULT 0,
  legacy_entries_count INTEGER NOT NULL DEFAULT 0,
  lineage_count INTEGER NOT NULL DEFAULT 0,
  lineage_ordinal INTEGER NOT NULL DEFAULT 0,
  lineage_incarnation INTEGER NOT NULL DEFAULT 0,
  sources_count INTEGER NOT NULL DEFAULT 0,
  sources_ordinal INTEGER NOT NULL DEFAULT 0,
  sources_incarnation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, epoch)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS journal_proj_submissions (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  item_key TEXT,
  input_ordinal INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT,
  submitted_seq INTEGER,
  submitted_at REAL,
  accepted_seq INTEGER,
  fence INTEGER,
  dispatch_state TEXT,
  write_failure INTEGER NOT NULL DEFAULT 0,
  recovered INTEGER NOT NULL DEFAULT 0,
  queued_message_id TEXT,
  echo_claimed INTEGER NOT NULL DEFAULT 0,
  item_present INTEGER NOT NULL DEFAULT 0,
  item_sequence INTEGER NOT NULL DEFAULT 0,
  item_unscoped INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, epoch, client_message_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_submissions_current
  ON journal_proj_submissions(session_id, epoch, client_message_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_submissions_order
  ON journal_proj_submissions(session_id, epoch, ordinal) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_submissions_echo
  ON journal_proj_submissions(session_id, epoch, fingerprint, submitted_at, input_ordinal)
  WHERE current=1 AND dispatch_state<>'rejected' AND write_failure=0 AND echo_claimed=0 AND item_present=1;
CREATE INDEX IF NOT EXISTS journal_proj_submissions_echo_clear
  ON journal_proj_submissions(session_id, epoch, fingerprint, submitted_at, input_ordinal)
  WHERE current=1 AND dispatch_state<>'rejected' AND write_failure=0 AND echo_claimed=0 AND item_present=1 AND accepted_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_proj_submissions_unopened
  ON journal_proj_submissions(session_id, epoch, item_sequence DESC, input_ordinal DESC)
  WHERE current=1 AND dispatch_state='accepted' AND item_present=1 AND item_unscoped=1;
CREATE INDEX IF NOT EXISTS journal_proj_submissions_item
  ON journal_proj_submissions(session_id, epoch, item_key) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_receipts (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  provider_item_id TEXT,
  cursor_epoch TEXT,
  cursor_seq INTEGER,
  accepted_at REAL,
  PRIMARY KEY (session_id, epoch, client_message_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_receipts_current
  ON journal_proj_receipts(session_id, epoch, client_message_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_receipts_order
  ON journal_proj_receipts(session_id, epoch, ordinal) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_queue_cards (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  position REAL,
  state TEXT,
  hold_reason TEXT,
  consumed_as TEXT,
  queued_epoch TEXT,
  queued_seq INTEGER,
  PRIMARY KEY (session_id, epoch, message_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_queue_cards_current
  ON journal_proj_queue_cards(session_id, epoch, message_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_queue_cards_order
  ON journal_proj_queue_cards(session_id, epoch, ordinal) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_queue_cards_live
  ON journal_proj_queue_cards(session_id, epoch, position, ordinal)
  WHERE current=1 AND state IN ('waiting', 'returned');
CREATE TABLE IF NOT EXISTS journal_proj_input_entries (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  basis TEXT,
  source_epoch TEXT,
  source_seq INTEGER,
  cut INTEGER,
  PRIMARY KEY (session_id, epoch, input_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_input_entries_current
  ON journal_proj_input_entries(session_id, epoch, input_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_entries_order
  ON journal_proj_input_entries(session_id, epoch, ordinal) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_entries_cut
  ON journal_proj_input_entries(session_id, epoch, cut) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_entries_basis
  ON journal_proj_input_entries(session_id, epoch, basis, ordinal) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_lineage_cards (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  introduced INTEGER,
  baseline_kind TEXT,
  baseline_epoch TEXT,
  baseline_seq INTEGER,
  PRIMARY KEY (session_id, epoch, message_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_lineage_cards_current
  ON journal_proj_lineage_cards(session_id, epoch, message_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_lineage_cards_order
  ON journal_proj_lineage_cards(session_id, epoch, ordinal) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_lineage_cards_introduced
  ON journal_proj_lineage_cards(session_id, epoch, introduced) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_input_sources (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  kind TEXT,
  source_epoch TEXT,
  source_seq INTEGER,
  fence INTEGER,
  PRIMARY KEY (session_id, epoch, input_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_input_sources_current
  ON journal_proj_input_sources(session_id, epoch, input_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_sources_order
  ON journal_proj_input_sources(session_id, epoch, ordinal) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_sources_sequence
  ON journal_proj_input_sources(session_id, epoch, kind, source_seq, ordinal) WHERE current=1;
`
}
