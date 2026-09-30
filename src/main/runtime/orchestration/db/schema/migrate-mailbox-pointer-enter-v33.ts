import type { OrchestrationDb } from '../orchestration-db'

export function migrateMailboxPointerEnterV33(this: OrchestrationDb, current: number): void {
  if (current >= 33) {
    return
  }
  const columns = [
    ['pointer_enter_pending', 'INTEGER NOT NULL DEFAULT 0'],
    ['pointer_pty_id', 'TEXT'],
    ['pointer_process_incarnation', 'TEXT']
  ] as const
  for (const [column, definition] of columns) {
    if (!this.hasColumn('messages', column)) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`)
    }
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_pending_pointer_enter
      ON messages(to_handle, sequence)
      WHERE read = 0 AND pointer_enter_pending > 0;
  `)
}
