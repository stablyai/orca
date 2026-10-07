import type { OrchestrationDb } from '../orchestration-db'

/**
 * Dispatch rows recorded who they were assigned to but never who created them, so a coordinator
 * that dispatched context to its own terminal read back as its own depth-1 worker and every later
 * `worker-start` from it failed the nesting cap. Nulls stay ambiguous and keep counting, which is
 * the pre-v37 behaviour and fails closed.
 */
export function migrateV37(this: OrchestrationDb, current: number): void {
  if (current >= 37) {
    return
  }
  for (const column of ['creator_handle', 'creator_pane_key']) {
    if (!this.hasColumn('dispatch_contexts', column)) {
      this.db.exec(`ALTER TABLE dispatch_contexts ADD COLUMN ${column} TEXT`)
    }
  }
}
