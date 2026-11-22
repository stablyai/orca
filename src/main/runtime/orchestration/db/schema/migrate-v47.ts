import type { OrchestrationDb } from '../orchestration-db'

/** Whether a Dispatch was started in a turn its creator chat's connector conversation woke. */
export function migrateV47(this: OrchestrationDb, current: number): void {
  if (current >= 47) {
    return
  }
  if (!this.hasColumn('dispatch_contexts', 'creator_turn_source')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN creator_turn_source TEXT')
  }
}
