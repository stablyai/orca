import type { OrchestrationDb } from '../orchestration-db'

/** The pair/time index the bot request pair quota reads as a range. */
export function migrateV53(this: OrchestrationDb, current: number): void {
  if (current >= 53) {
    return
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bot_requests_pair
      ON bot_requests(from_bot_id, to_bot_id, created_at);
  `)
}
