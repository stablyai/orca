import type { OrchestrationDb } from '../orchestration-db'

// Tests that hand-edit the deliveries table must drop the derived objects first: SQLite refuses
// DROP COLUMN / RENAME while a trigger or view still references the table. Reopening recreates them.
export function dropDerivedDeliverySchema(db: OrchestrationDb['db']): void {
  db.exec(
    'DROP TRIGGER IF EXISTS trg_deliveries_one_outstanding; DROP VIEW IF EXISTS outstanding_deliveries;'
  )
}
