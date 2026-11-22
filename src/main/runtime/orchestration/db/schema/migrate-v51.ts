import type { OrchestrationDb } from '../orchestration-db'
import { WORKER_PLACEMENT_CATALOG_SCHEMA_SQL } from '../remote-owned/worker-placement-catalog-store'

export function migrateV51(this: OrchestrationDb, current: number): void {
  if (current < 51) {
    this.db.exec(WORKER_PLACEMENT_CATALOG_SCHEMA_SQL)
  }
}
