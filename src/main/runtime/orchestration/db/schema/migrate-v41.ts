import type { OrchestrationDb } from '../orchestration-db'

// Drop uniqueness so read-but-unacked batches cannot block new mail; retain the index name/predicate for downgrade probes.
export const OUTSTANDING_MAILBOX_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_deliveries_one_outstanding
    ON deliveries(mailbox_handle) WHERE status = 'outstanding' AND mailbox_handle != '';
`

const OUTSTANDING_DELIVERY_TRIGGER = `trg_deliveries_one_outstanding
    AFTER INSERT ON deliveries
    WHEN NEW.mailbox_handle != '' AND EXISTS (
      SELECT 1 FROM outstanding_deliveries
       WHERE mailbox_handle = NEW.mailbox_handle AND mailbox_handle != '' LIMIT 1 OFFSET 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'Mailbox already has an outstanding delivery');
    END`

export const DERIVED_DELIVERY_SCHEMA_SQL = `
  CREATE VIEW IF NOT EXISTS outstanding_deliveries AS
    SELECT * FROM deliveries
    WHERE status = 'outstanding'
      AND EXISTS (
        SELECT 1 FROM json_each(deliveries.message_ids) AS member
        JOIN messages ON messages.id = member.value WHERE messages.read = 0
      );
  CREATE TRIGGER IF NOT EXISTS ${OUTSTANDING_DELIVERY_TRIGGER};
`

/** IF NOT EXISTS keeps an older trigger body forever, so rebuild it when the stored SQL differs. */
export function refreshOutstandingDeliveryTrigger(db: OrchestrationDb['db']): void {
  const stored = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get('trg_deliveries_one_outstanding')?.sql
  if (stored === `CREATE TRIGGER ${OUTSTANDING_DELIVERY_TRIGGER}`) {
    return
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(
      `DROP TRIGGER IF EXISTS trg_deliveries_one_outstanding;
       CREATE TRIGGER ${OUTSTANDING_DELIVERY_TRIGGER};`
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function migrateV41(this: OrchestrationDb, current: number): void {
  if (current >= 41) {
    return
  }
  this.db.exec(
    `DROP INDEX IF EXISTS idx_deliveries_one_outstanding;\n${OUTSTANDING_MAILBOX_INDEX_SQL}`
  )
}
