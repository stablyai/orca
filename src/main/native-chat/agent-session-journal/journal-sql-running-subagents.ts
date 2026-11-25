import type Database from '../../sqlite/sync-database'
import {
  JOURNAL_RUNNING_SUBAGENTS_MAX,
  type JournalRunningSubagent
} from './journal-running-subagents'
import type { AgentJournalProducerLinkage } from '../../../shared/agent-session/journal/agent-session-journal-types'

/**
 * Child agents whose saved turn is still open, with their parent: saved with the rows (before any
 * relay ack), so a reattach after a crash still knows every child that can go on writing.
 */
export function readJournalDomainRunningSubagents(
  db: Database.Database,
  prefix: readonly [string, string]
): { subagents: JournalRunningSubagent[]; more: boolean } {
  // The most recently active first: past the cap, the oldest go unnamed (the caller logs it).
  const rows = db
    .prepare(`SELECT producer_agent_id, placement_json, MAX(ordinal) AS latest FROM journal_items
    INDEXED BY journal_items_producer_attempt
    WHERE session_id=? AND epoch=? AND hidden=0 AND producer_agent_id IS NOT NULL
      AND kind='turn' AND lifecycle_state IN ('running','pending')
    GROUP BY producer_agent_id ORDER BY latest DESC LIMIT ?`)
    .all(...prefix, JOURNAL_RUNNING_SUBAGENTS_MAX + 1)
  const subagents = rows.slice(0, JOURNAL_RUNNING_SUBAGENTS_MAX).map((row) => {
    const linkage: AgentJournalProducerLinkage = JSON.parse(String(row.placement_json))
    return {
      agentId: String(row.producer_agent_id),
      ...(linkage.parentAgentId ? { parentAgentId: linkage.parentAgentId } : {})
    }
  })
  return { subagents, more: rows.length > JOURNAL_RUNNING_SUBAGENTS_MAX }
}
