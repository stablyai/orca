import type { OrchestrationDb } from '../orchestration-db'
import { WORKER_PLACEMENT_CATALOG_SCHEMA_SQL } from '../remote-owned/worker-placement-catalog-store'

export function migrateV50(this: OrchestrationDb, current: number): void {
  if (current < 50) {
    this.db.exec(WORKER_PLACEMENT_CATALOG_SCHEMA_SQL)
  }
}
