import type Database from '../sqlite/sync-database'

/** Committed forward pointers derive a reverse lookup without native IO on sender reads. */
export class AgentSessionRecordLineage {
  private readonly successors = new Map<string, string>()
  private readonly predecessors = new Map<string, Set<string>>()

  set(sessionId: string, successor: string | null): void {
    const previous = this.successors.get(sessionId)
    if (previous === successor) {
      return
    }
    if (previous) {
      const rows = this.predecessors.get(previous)
      rows?.delete(sessionId)
      if (rows?.size === 0) {
        this.predecessors.delete(previous)
      }
      this.successors.delete(sessionId)
    }
    if (successor) {
      this.successors.set(sessionId, successor)
      const rows = this.predecessors.get(successor) ?? new Set<string>()
      rows.add(sessionId)
      this.predecessors.set(successor, rows)
    }
  }

  list(sessionId: string): string[] {
    return [...(this.predecessors.get(sessionId) ?? [])]
  }
}

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
