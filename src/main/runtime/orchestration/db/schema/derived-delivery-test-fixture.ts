import type { OrchestrationDb } from '../orchestration-db'

// Drop derived triggers/views before hand-editing deliveries; reopening recreates them.
export function dropDerivedDeliverySchema(db: OrchestrationDb['db']): void {
  db.exec(
    'DROP TRIGGER IF EXISTS trg_deliveries_one_outstanding; DROP VIEW IF EXISTS outstanding_deliveries;'
  )
}
