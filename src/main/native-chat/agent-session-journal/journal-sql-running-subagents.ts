import type Database from '../../sqlite/sync-database'
import type { AgentJournalProducerLinkage } from '../../../shared/agent-session/journal/agent-session-journal-types'

/** More running children than a reopen numbers; past it the read refuses rather than drops one. */
export const JOURNAL_RUNNING_SUBAGENTS_MAX = 64

export type JournalRunningSubagent = { agentId: string; parentAgentId?: string }

/**
 * Child agents whose saved turn is still open, with their parent: saved with the rows (before any
 * relay ack), so a reattach after a crash still knows every child that can go on writing.
 */
export function readJournalDomainRunningSubagents(
  db: Database.Database,
  prefix: readonly [string, string]
): JournalRunningSubagent[] {
  const rows = db
    .prepare(`SELECT producer_agent_id, placement_json FROM journal_items
    INDEXED BY journal_items_producer_attempt
    WHERE session_id=? AND epoch=? AND hidden=0 AND producer_agent_id IS NOT NULL
      AND kind='turn' AND lifecycle_state IN ('running','pending')
    GROUP BY producer_agent_id LIMIT ?`)
    .all(...prefix, JOURNAL_RUNNING_SUBAGENTS_MAX + 1)
  if (rows.length > JOURNAL_RUNNING_SUBAGENTS_MAX) {
    throw new Error('Too many running subagents to reopen')
  }
  return rows.map((row) => {
    const linkage: AgentJournalProducerLinkage = JSON.parse(String(row.placement_json))
    return {
      agentId: String(row.producer_agent_id),
      ...(linkage.parentAgentId ? { parentAgentId: linkage.parentAgentId } : {})
    }
  })
}
