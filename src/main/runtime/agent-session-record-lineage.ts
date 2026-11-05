import type { JournalReadConnection } from '../native-chat/agent-session-journal/journal-sql-owner'

export const AGENT_SESSION_PREDECESSOR_IDS = `SELECT session_id FROM agent_session_records
    WHERE CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.conversationCommand.replacementSessionId') END = ?`
let predecessorWork = { seeks: 0, rows: 0 }
export const agentSessionPredecessorWorkForTest = () => predecessorWork

/** Every saved record whose clear command names this session, any phase, through the clear
 *  successor index: candidates for callers to validate, never proof of a committed clear. */
export async function* agentSessionRecordPredecessorIds(
  db: JournalReadConnection,
  sessionId: string
): AsyncGenerator<string> {
  predecessorWork = { ...predecessorWork, seeks: predecessorWork.seeks + 1 }
  for await (const rows of db.pages(AGENT_SESSION_PREDECESSOR_IDS, [sessionId])) {
    predecessorWork = { ...predecessorWork, rows: predecessorWork.rows + rows.length }
    for (const row of rows) {
      if (typeof row.session_id === 'string') {
        yield row.session_id
      }
    }
  }
}
