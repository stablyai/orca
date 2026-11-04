import type Database from '../sqlite/sync-database'

export const AGENT_SESSION_PREDECESSOR_IDS = `SELECT session_id FROM agent_session_records
    WHERE CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.conversationCommand.replacementSessionId') END = ?`
let predecessorWork = { seeks: 0, rows: 0 }
export const agentSessionPredecessorWorkForTest = () => predecessorWork

/** Every saved record whose clear command names this session, any phase, through the clear
 *  successor index: candidates for callers to validate, never proof of a committed clear. */
export function agentSessionRecordPredecessorIds(
  db: Database.Database,
  sessionId: string
): string[] {
  const rows = db.prepare(AGENT_SESSION_PREDECESSOR_IDS).all(sessionId)
  predecessorWork = { seeks: predecessorWork.seeks + 1, rows: predecessorWork.rows + rows.length }
  return rows.flatMap((row) => (typeof row.session_id === 'string' ? [row.session_id] : []))
}
