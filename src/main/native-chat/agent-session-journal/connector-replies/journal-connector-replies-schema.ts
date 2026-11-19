/**
 * The reply outbox (design item 125): one row per admitted connector delivery, written with its
 * admission, filled with its outcome at turn end or at boot, and deleted once the cloud accepted it.
 * Created without a user_version change, like the stored output column: released builds name their
 * tables and never read it.
 */
export const JOURNAL_CONNECTOR_REPLIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS journal_connector_replies (
  account TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  queued INTEGER NOT NULL,
  outcome TEXT,
  answer_delivery_id TEXT,
  turn_item_id TEXT,
  prose TEXT,
  failure_json TEXT,
  links_json TEXT,
  filled_at INTEGER,
  sent_at INTEGER,
  PRIMARY KEY(account, delivery_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_connector_replies_open
  ON journal_connector_replies(session_id, outcome, sent_at);
`
