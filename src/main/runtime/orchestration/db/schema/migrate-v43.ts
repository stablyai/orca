import type { OrchestrationDb } from '../orchestration-db'

export function migrateV43(this: OrchestrationDb, current: number): void {
  if (current < 43 && !this.hasColumn('messages', 'notify')) {
    this.db.exec(
      'ALTER TABLE messages ADD COLUMN notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0, 1))'
    )
  }
}
