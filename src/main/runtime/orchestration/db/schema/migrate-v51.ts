import type { OrchestrationDb } from '../orchestration-db'

/** Whether a Dispatch's worker, and the workers under it, start as chats. Skipped when present. */
export function migrateV51(this: OrchestrationDb, current: number): void {
  if (current >= 51) {
    return
  }
  if (!this.hasColumn('dispatch_contexts', 'chat_lineage')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN chat_lineage INTEGER')
  }
}
