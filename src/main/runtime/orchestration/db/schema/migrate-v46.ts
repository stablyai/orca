import type { OrchestrationDb } from '../orchestration-db'

/** v46: room members keep a durable busy/failed state for the chat UI. */
export function migrateV46(this: OrchestrationDb, current: number): void {
  if (current >= 46) {
    return
  }
  const cols = this.db.prepare(`PRAGMA table_info(room_members)`).all()
  if (!cols.some((col) => col.name === 'status')) {
    this.db.exec(`ALTER TABLE room_members ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'`)
  }
  if (!cols.some((col) => col.name === 'status_updated_at')) {
    this.db.exec(`ALTER TABLE room_members ADD COLUMN status_updated_at TEXT NOT NULL DEFAULT ''`)
  }
}
