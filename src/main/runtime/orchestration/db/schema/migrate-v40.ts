import type { OrchestrationDb } from '../orchestration-db'

export function migrateV40(this: OrchestrationDb, current: number): void {
  if (current >= 40) {
    return
  }
  if (!this.hasColumn('tasks', 'worktree_id')) {
    this.db.exec('ALTER TABLE tasks ADD COLUMN worktree_id TEXT')
  }
  if (!this.hasColumn('tasks', 'branch')) {
    this.db.exec('ALTER TABLE tasks ADD COLUMN branch TEXT')
  }
  this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_worktree ON tasks(worktree_id)')
}
