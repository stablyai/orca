import type { OrchestrationDb } from '../orchestration-db'

/** Record creators to distinguish self-bookkeeping from depth-1 workers; legacy nulls conservatively remain parents. */
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
