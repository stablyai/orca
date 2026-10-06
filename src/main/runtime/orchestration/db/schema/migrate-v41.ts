import type { OrchestrationDb } from '../orchestration-db'

// Why: eligibility comes from unread membership, so a fully read but unacknowledged batch must not
// block the next insert. The index keeps its pre-v41 name and predicate so downgraded binaries'
// IF NOT EXISTS create and schema probes still pass; only uniqueness is dropped.
export const OUTSTANDING_MAILBOX_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_deliveries_one_outstanding
    ON deliveries(mailbox_handle) WHERE status = 'outstanding' AND mailbox_handle != '';
`

export const DERIVED_DELIVERY_SCHEMA_SQL = `
  CREATE VIEW IF NOT EXISTS outstanding_deliveries AS
    SELECT * FROM deliveries
    WHERE status = 'outstanding'
      AND EXISTS (
        SELECT 1 FROM json_each(deliveries.message_ids) AS member
        JOIN messages ON messages.id = member.value WHERE messages.read = 0
      );
  CREATE TRIGGER IF NOT EXISTS trg_deliveries_one_outstanding
    AFTER INSERT ON deliveries
    WHEN NEW.mailbox_handle != '' AND EXISTS (
      SELECT 1 FROM outstanding_deliveries WHERE mailbox_handle = NEW.mailbox_handle LIMIT 1 OFFSET 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'Mailbox already has an outstanding delivery');
    END;
`

export function migrateV41(this: OrchestrationDb, current: number): void {
  if (current >= 41) {
    return
  }
  this.db.exec(
    `DROP INDEX IF EXISTS idx_deliveries_one_outstanding;\n${OUTSTANDING_MAILBOX_INDEX_SQL}`
  )
}
