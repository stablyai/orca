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
  took_ms INTEGER,
  admitted_at INTEGER,
  expired_reason TEXT,
  PRIMARY KEY(account, delivery_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_connector_replies_open
  ON journal_connector_replies(session_id, outcome, sent_at);
`

// Columns later builds added; a table an earlier build made gets each the same way, with no
// user_version change. admitted_at: when the admission committed (request age); expired_reason:
// local only, why recovery settled a row quietly.
const ADDED_COLUMNS = [
  ['took_ms', 'INTEGER'],
  ['admitted_at', 'INTEGER'],
  ['expired_reason', 'TEXT']
] as const

export function ensureJournalConnectorRepliesSchema(db: {
  exec(sql: string): unknown
  prepare(sql: string): { get(): unknown }
}): void {
  db.exec(JOURNAL_CONNECTOR_REPLIES_SCHEMA)
  for (const [name, type] of ADDED_COLUMNS) {
    const present = db
      .prepare(`SELECT 1 FROM pragma_table_info('journal_connector_replies') WHERE name='${name}'`)
      .get()
    if (!present) {
      db.exec(`ALTER TABLE journal_connector_replies ADD COLUMN ${name} ${type}`)
    }
  }
}
