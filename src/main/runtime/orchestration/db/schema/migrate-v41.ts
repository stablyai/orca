import type { OrchestrationDb } from '../orchestration-db'

export function migrateV41(this: OrchestrationDb, current: number): void {
  if (current >= 41) {
    return
  }
  for (const statement of [
    'ALTER TABLE runs ADD COLUMN coordinator_agent_session_id TEXT',
    'ALTER TABLE dispatch_contexts ADD COLUMN assignee_agent_session_id TEXT'
  ]) {
    try {
      this.db.exec(statement)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column name')) {
        throw error
      }
    }
  }
}
