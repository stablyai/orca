import type Database from '../sqlite/sync-database'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

/** Indexed reverse links cover historical clear successors without scanning every conversation. */
export function agentSessionRecordLineage(
  db: Database.Database,
  record: AgentSessionRecord,
  getRecord: (id: string) => AgentSessionRecord | null
): AgentSessionRecord[] {
  const records = [record]
  const seen = new Set([record.sessionId])
  const prior = db.prepare(`SELECT session_id FROM agent_session_records
    WHERE CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.conversationCommand.replacementSessionId') END = ?`)
  for (let current = record; ;) {
    const rows = prior.all(current.sessionId)
    if (
      rows.length !== 1 ||
      typeof rows[0].session_id !== 'string' ||
      seen.has(rows[0].session_id)
    ) {
      return records.toReversed()
    }
    const earlier = getRecord(rows[0].session_id)
    if (
      earlier?.conversationCommand?.command !== 'clear' ||
      earlier.conversationCommand.phase !== 'committed'
    ) {
      return records.toReversed()
    }
    seen.add(earlier.sessionId)
    records.push(earlier)
    current = earlier
  }
}
