import type { OrchestrationDb } from '../orchestration-db'

/** Point lookups for finding a legacy Run's coordinator: the Runs its adoption failed, and each
 *  legacy mail's Dispatch by assignee within its Run (a handle reused across Runs stays one probe). */
export function migrateV49(this: OrchestrationDb, current: number): void {
  if (current >= 49) {
    return
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_coordinator_runs_scheduler_lost
      ON coordinator_runs(scheduler_lost_at) WHERE scheduler_lost_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_run_contract
      ON dispatch_contexts(assignee_handle, run_id, contract_version) WHERE assignee_handle IS NOT NULL;
  `)
}
