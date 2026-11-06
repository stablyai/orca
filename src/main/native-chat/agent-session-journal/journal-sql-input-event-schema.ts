export function journalSqlInputEventSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_input_rejections (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  source_kind TEXT,
  source_epoch TEXT,
  source_seq INTEGER,
  fence REAL,
  dispatch_state TEXT,
  provider_item_id TEXT,
  PRIMARY KEY (session_id, epoch, input_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_input_rejections_current
  ON journal_proj_input_rejections(session_id, epoch, input_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_rejections_order
  ON journal_proj_input_rejections(session_id, epoch, ordinal) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_input_presentations (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  source_kind TEXT,
  source_epoch TEXT,
  source_seq INTEGER,
  fence REAL,
  dispatch_state TEXT,
  message_id TEXT,
  queue_operation TEXT,
  PRIMARY KEY (session_id, epoch, input_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_input_presentations_current
  ON journal_proj_input_presentations(session_id, epoch, input_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_presentations_order
  ON journal_proj_input_presentations(session_id, epoch, ordinal) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_input_handovers (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  source_epoch TEXT,
  source_seq INTEGER,
  fence REAL,
  dispatch_state TEXT,
  PRIMARY KEY (session_id, epoch, input_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_input_handovers_current
  ON journal_proj_input_handovers(session_id, epoch, input_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_handovers_order
  ON journal_proj_input_handovers(session_id, epoch, ordinal) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_input_ends (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  end_kind TEXT,
  turn_id TEXT,
  stop_reason TEXT,
  PRIMARY KEY (session_id, epoch, input_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_input_ends_current
  ON journal_proj_input_ends(session_id, epoch, input_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_ends_order
  ON journal_proj_input_ends(session_id, epoch, ordinal) WHERE current=1;
`
}
