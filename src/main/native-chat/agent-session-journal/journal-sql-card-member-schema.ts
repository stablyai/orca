export function journalSqlCardMemberSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_current_cards (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  card_id TEXT,
  card_incarnation INTEGER,
  position REAL,
  state TEXT,
  PRIMARY KEY (session_id, epoch, message_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_current_cards_current
  ON journal_proj_current_cards(session_id, epoch, message_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_current_cards_order
  ON journal_proj_current_cards(session_id, epoch, ordinal) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_overlay_cards (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  card_id TEXT,
  card_incarnation INTEGER,
  position REAL,
  state TEXT,
  PRIMARY KEY (session_id, epoch, message_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_overlay_cards_current
  ON journal_proj_overlay_cards(session_id, epoch, message_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_overlay_cards_order
  ON journal_proj_overlay_cards(session_id, epoch, ordinal) WHERE current=1;
CREATE TABLE IF NOT EXISTS journal_proj_indexed_cards (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  current INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  card_id TEXT,
  card_incarnation INTEGER,
  position REAL,
  state TEXT,
  lineage_message_id TEXT,
  lineage_incarnation INTEGER,
  actionable INTEGER,
  handoff INTEGER,
  released INTEGER,
  released_at REAL,
  PRIMARY KEY (session_id, epoch, message_id, incarnation)
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS journal_proj_indexed_cards_current
  ON journal_proj_indexed_cards(session_id, epoch, message_id) WHERE current=1;
CREATE INDEX IF NOT EXISTS journal_proj_indexed_cards_order
  ON journal_proj_indexed_cards(session_id, epoch, ordinal) WHERE current=1;
`
}
