import type Database from '../../sqlite/sync-database'

/**
 * Queue order is a typed column beside the card body, never its version key. Ties keep today's
 * message-id order, which no edit, move or handover changes, so no separate admission column.
 */
const JOURNAL_DOMAIN_QUEUE_SCHEMA = `
ALTER TABLE journal_card_versions ADD COLUMN position REAL;
UPDATE journal_card_versions SET position=json_extract(payload_json,'$.position');
CREATE INDEX journal_card_order ON journal_card_versions(session_id, epoch, position, message_id)
  WHERE current=1 AND state IN ('waiting','returned');
CREATE INDEX journal_card_last_position ON journal_card_versions(session_id, epoch, position)
  WHERE current=1;
CREATE INDEX journal_submission_source_card ON journal_submission_attempts(session_id, epoch, source_card_sequence, source_card_index)
  WHERE source_card_sequence IS NOT NULL;
`

/** Runs once inside the caller's migration transaction; existing card bodies are kept as saved. */
export function migrateJournalDomainQueueSchema(db: Database.Database): void {
  if (!db.isTransaction) {
    throw new Error('journal queue schema requires its migration transaction')
  }
  const installed = db
    .prepare(`SELECT 1 FROM pragma_table_info('journal_card_versions') WHERE name='position'`)
    .get()
  if (!installed) {
    db.exec(JOURNAL_DOMAIN_QUEUE_SCHEMA)
  }
}
