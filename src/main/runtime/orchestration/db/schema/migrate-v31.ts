import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationV31(this: OrchestrationDb, current: number): void {
  if (current >= 31) {
    return
  }
  if (!this.hasColumn('runs', 'target_concurrency')) {
    this.db.exec(
      'ALTER TABLE runs ADD COLUMN target_concurrency INTEGER NOT NULL DEFAULT 0 CHECK(target_concurrency BETWEEN 0 AND 64)'
    )
  }
  if (!this.hasColumn('tasks', 'capacity_eligible')) {
    this.db.exec(
      'ALTER TABLE tasks ADD COLUMN capacity_eligible INTEGER NOT NULL DEFAULT 0 CHECK(capacity_eligible IN (0, 1))'
    )
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_capacity_ready
      ON tasks(run_id, capacity_eligible, status, created_at);
  `)
}
