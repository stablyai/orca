import type { OrchestrationDb } from '../orchestration-db'

/** A workspace's worker rows by its id, for the empty chat's finished-worker list. */
export function migrateV52(this: OrchestrationDb, current: number): void {
  if (current >= 52) {
    return
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_worktree
      ON worker_terminal_resources(worktree_id);
  `)
}
