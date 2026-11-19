import type { OrchestrationDb } from '../orchestration-db'

export function migrateV49(this: OrchestrationDb, current: number): void {
  if (current >= 49) {
    return
  }
  if (!this.hasColumn('tasks', 'model')) {
    this.db.exec('ALTER TABLE tasks ADD COLUMN model TEXT')
  }
  if (!this.hasColumn('tasks', 'effort')) {
    this.db.exec('ALTER TABLE tasks ADD COLUMN effort TEXT')
  }
}
