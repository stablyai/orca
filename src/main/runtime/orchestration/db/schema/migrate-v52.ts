import type { OrchestrationDb } from '../orchestration-db'

/** Passive live progress note recorded on an active worker Dispatch without mailing its coordinator. */
export function migrateV52(this: OrchestrationDb, current: number): void {
  if (current >= 52) {
    return
  }
  for (const column of ['progress_note', 'progress_updated_at'] as const) {
    if (!this.hasColumn('dispatch_contexts', column)) {
      this.db.exec(`ALTER TABLE dispatch_contexts ADD COLUMN ${column} TEXT`)
    }
  }
}
