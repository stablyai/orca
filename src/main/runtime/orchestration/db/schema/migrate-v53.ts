import type { OrchestrationDb } from '../orchestration-db'

/** Separates inherited bot commit guidance from the worker-surface lineage. */
export function migrateV53(this: OrchestrationDb, current: number): void {
  if (current < 53 && !this.hasColumn('dispatch_contexts', 'bot_lineage')) {
    this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN bot_lineage INTEGER')
  }
}
