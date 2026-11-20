import type { OrchestrationDb } from '../orchestration-db'

/** Agent questions owe their asker one notice: which rule each follows, and the chat that took it. */
export function migrateV50(this: OrchestrationDb, current: number): void {
  if (current >= 50) {
    return
  }
  for (const column of [
    'debt_rule INTEGER',
    'taken_session_id TEXT',
    'taken_by TEXT',
    'decided_session_id TEXT'
  ]) {
    if (!this.hasColumn('bot_requests', column.split(' ')[0])) {
      this.db.exec(`ALTER TABLE bot_requests ADD COLUMN ${column}`)
    }
  }
  this.db.exec(BOT_REQUEST_OPEN_TAKE_INDEX_SQL)
}

/** Only takes still owed an outcome under the new rule: settled ones leave it, so it stays small. */
export const BOT_REQUEST_OPEN_TAKE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_bot_requests_open_take
  ON bot_requests(taken_session_id) WHERE taken_session_id IS NOT NULL AND debt_rule = 1;
CREATE INDEX IF NOT EXISTS idx_bot_requests_decided_session
  ON bot_requests(decided_session_id) WHERE decided_session_id IS NOT NULL;
`
