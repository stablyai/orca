import type { OrchestrationDb } from '../orchestration-db'

/** Per-Run wake allow-list for orchestration mail pointers. */
export function migrateV47(this: OrchestrationDb, current: number): void {
  if (current >= 47) {
    return
  }
  if (!this.hasColumn('runs', 'notify_types')) {
    this.db.exec('ALTER TABLE runs ADD COLUMN notify_types TEXT')
  }
}
