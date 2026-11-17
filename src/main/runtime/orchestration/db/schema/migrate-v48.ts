import type { OrchestrationDb } from '../orchestration-db'

/** v48: rooms remember the worktree selector admin tools spawn new bots under. */
export function migrateV48(this: OrchestrationDb, current: number): void {
  if (current >= 48) {
    return
  }
  const cols = this.db.prepare(`PRAGMA table_info(rooms)`).all() as { name: string }[]
  if (!cols.some((col) => col.name === 'worktree')) {
    this.db.exec(`ALTER TABLE rooms ADD COLUMN worktree TEXT NOT NULL DEFAULT ''`)
  }
}
