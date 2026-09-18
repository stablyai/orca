import type { OrchestrationDb } from '../orchestration-db'

/**
 * Residual N: `failActiveDispatchOnExit` had the process exit code in hand and dropped it
 * before `failDispatch`, so no attempt's exit code was ever attributable to its dispatch id.
 */
export function migrateV42(this: OrchestrationDb, current: number): void {
  if (current >= 42) {
    return
  }
  if (!this.hasColumn('dispatch_contexts', 'exit_code')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN exit_code INTEGER')
  }
}
