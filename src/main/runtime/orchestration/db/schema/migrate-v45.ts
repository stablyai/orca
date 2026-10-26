import type { OrchestrationDb } from '../orchestration-db'

/** v45: rooms remember the worktree selector admin tools spawn new bots under. */
export function migrateV45(this: OrchestrationDb, current: number): void {
  if (current >= 45) {
    return
  }
  const cols = this.db.prepare(`PRAGMA table_info(rooms)`).all()
  if (!cols.some((col) => col.name === 'worktree')) {
    this.db.exec(`ALTER TABLE rooms ADD COLUMN worktree TEXT NOT NULL DEFAULT ''`)
  }
}
