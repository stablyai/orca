import type { OrchestrationDb } from '../orchestration-db'

/**
 * `messages.busy_delivery`: what the sender asked a chat in the middle of a turn to do with the
 * message, `queue` (a card sent when the turn ends) or `steer` (into the running turn). Rows
 * written before it were all queued, which the default says.
 */
export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current >= 44) {
    return
  }
  // Guarded because createTables runs first on every open and already gives a fresh database this.
  if (!this.hasColumn('messages', 'busy_delivery')) {
    this.db.exec(`ALTER TABLE messages ADD COLUMN busy_delivery TEXT NOT NULL DEFAULT 'queue'`)
  }
}
