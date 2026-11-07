export function journalSqlSubmissionMemberSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_input_candidates (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  submission_id TEXT,
  submission_incarnation INTEGER,
  fence REAL,
  submitted_seq INTEGER,
  effective_fence REAL,
  handover_fence REAL,
  PRIMARY KEY (session_id, epoch, input_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_input_candidates_current
  ON journal_proj_input_candidates(session_id, epoch, input_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_candidates_order
  ON journal_proj_input_candidates(session_id, epoch, ordinal) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_queued_inputs (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  submission_id TEXT,
  submission_incarnation INTEGER,
  fence REAL,
  submitted_seq INTEGER,
  PRIMARY KEY (session_id, epoch, input_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_queued_inputs_current
  ON journal_proj_queued_inputs(session_id, epoch, input_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_queued_inputs_order
  ON journal_proj_queued_inputs(session_id, epoch, ordinal) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_entered_inputs (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  submission_id TEXT,
  submission_incarnation INTEGER,
  fence REAL,
  submitted_seq INTEGER,
  PRIMARY KEY (session_id, epoch, input_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_entered_inputs_current
  ON journal_proj_entered_inputs(session_id, epoch, input_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_entered_inputs_order
  ON journal_proj_entered_inputs(session_id, epoch, ordinal) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_recoverable_inputs (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  submission_id TEXT,
  submission_incarnation INTEGER,
  fence REAL,
  submitted_seq INTEGER,
  PRIMARY KEY (session_id, epoch, input_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_recoverable_inputs_current
  ON journal_proj_recoverable_inputs(session_id, epoch, input_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_recoverable_inputs_order
  ON journal_proj_recoverable_inputs(session_id, epoch, ordinal) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_pending_status_inputs (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  input_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  submission_id TEXT,
  submission_incarnation INTEGER,
  fence REAL,
  submitted_seq INTEGER,
  PRIMARY KEY (session_id, epoch, input_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_pending_status_inputs_current
  ON journal_proj_pending_status_inputs(session_id, epoch, input_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_pending_status_inputs_order
  ON journal_proj_pending_status_inputs(session_id, epoch, ordinal) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_candidates_effective
  ON journal_proj_input_candidates(session_id, epoch, effective_fence, ordinal) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_input_candidates_handover
  ON journal_proj_input_candidates(session_id, epoch, handover_fence, ordinal)
  WHERE current=1 AND handover_fence IS NOT NULL;
`
}
