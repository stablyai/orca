import type { OrchestrationDb } from '../orchestration-db'

export function migrateV49(this: OrchestrationDb, current: number): void {
  if (current >= 49) {
    return
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_bot_requests_pair
      ON bot_requests(from_bot_id, to_bot_id, created_at);
  `)
}
