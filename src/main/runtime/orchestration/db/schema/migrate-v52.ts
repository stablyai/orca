import type { OrchestrationDb } from '../orchestration-db'

/** Passive live progress note recorded on a Task and its active Dispatch without mailing its coordinator. */
export function migrateV52(this: OrchestrationDb, current: number): void {
  if (current >= 52) {
    return
  }
  for (const table of ['tasks', 'dispatch_contexts'] as const) {
    for (const column of ['progress_note', 'progress_updated_at'] as const) {
      if (!this.hasColumn(table, column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
      }
    }
  }
}
