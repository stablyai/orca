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
  turn_started_at INTEGER,
  cut_turn_id TEXT,
  cut_kind TEXT,
  claim_message_id TEXT,
  quiet_rule TEXT,
  tools_ran INTEGER,
  PRIMARY KEY(account, delivery_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_connector_replies_open
  ON journal_connector_replies(session_id, outcome, sent_at);
`

// Columns later builds added the same way, with no user_version change: an older build never reads
// them. turn_started_at: the answering turn's turn-started `at`, which its reply names. cut_turn_id / cut_kind: the cut that owes the row; claim_message_id: the continuation that
// claimed it. quiet_rule: the quiet-marker rule the row was admitted under. tools_ran: a turn done
// without an answer ran a tool call that may have changed something.
const ADDED_COLUMNS = [
  ['took_ms', 'INTEGER'],
  ['turn_started_at', 'INTEGER'],
  ['cut_turn_id', 'TEXT'],
  ['cut_kind', 'TEXT'],
  ['claim_message_id', 'TEXT'],
  ['quiet_rule', 'TEXT'],
  ['tools_ran', 'INTEGER']
] as const

/** Creates the table, and adds the columns a table an earlier build made lacks. */
export function ensureJournalConnectorRepliesSchema(db: {
  exec(sql: string): unknown
  prepare(sql: string): { get(...params: unknown[]): unknown }
}): void {
  db.exec(JOURNAL_CONNECTOR_REPLIES_SCHEMA)
  for (const [name, type] of ADDED_COLUMNS) {
    const present = db
      .prepare(`SELECT 1 FROM pragma_table_info('journal_connector_replies') WHERE name=?`)
      .get(name)
    if (!present) {
      db.exec(`ALTER TABLE journal_connector_replies ADD COLUMN ${name} ${type}`)
    }
  }
  // A Stop finds the rows of the messages it took back; an older build ignores these indexes.
  db.exec(`CREATE INDEX IF NOT EXISTS journal_connector_replies_message
    ON journal_connector_replies(session_id, epoch, message_id) WHERE outcome IS NULL;
  CREATE INDEX IF NOT EXISTS journal_connector_replies_claim
    ON journal_connector_replies(claim_message_id) WHERE claim_message_id IS NOT NULL`)
}
