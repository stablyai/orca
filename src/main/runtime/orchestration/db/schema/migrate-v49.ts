import type { OrchestrationDb } from '../orchestration-db'

/** Finds the coordinator Runs a legacy adoption failed by their adoption time, without reading every Run. */
export function migrateV49(this: OrchestrationDb, current: number): void {
  if (current >= 49) {
    return
  }
  this.db.exec(`CREATE INDEX IF NOT EXISTS idx_coordinator_runs_scheduler_lost
    ON coordinator_runs(scheduler_lost_at) WHERE scheduler_lost_at IS NOT NULL`)
}
