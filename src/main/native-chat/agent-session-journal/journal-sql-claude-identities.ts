import type { ClaudeJournalSnapshot } from '../../claude/claude-subagent-journaled-identities'
import type { JournalSqlScope } from './journal-sql-scope'

/** Read the derived columns only: the last alias per parent, the floored highest attempt, the roster. */
export function readJournalSqlClaudeIdentities(
  scope: JournalSqlScope
): Omit<ClaudeJournalSnapshot, 'threadGoal'> {
  const canonical = new Map<string, string>()
  for (const row of scope.db
    .prepare(`SELECT producer_parent_ref, producer_agent_id FROM journal_proj_items
    WHERE session_id=? AND epoch=? AND producer_parent_ref IS NOT NULL AND hidden=0 ORDER BY ordinal`)
    .all(...scope.prefix)) {
    scope.examined(row)
    canonical.set(String(row.producer_parent_ref), String(row.producer_agent_id))
  }
  const attempts: [string, number][] = []
  for (const row of scope.db
    .prepare(`SELECT producer_agent_id, MAX(producer_attempt) AS attempt FROM journal_proj_items
    WHERE session_id=? AND epoch=? AND producer_agent_id IS NOT NULL AND hidden=0
    GROUP BY producer_agent_id`)
    .all(...scope.prefix)) {
    scope.examined(row)
    attempts.push([String(row.producer_agent_id), Math.max(1, Number(row.attempt))])
  }
  const subagents = new Set<string>()
  for (const row of scope.db
    .prepare(`SELECT subagent_names FROM journal_proj_items
    WHERE session_id=? AND epoch=? AND subagent_names IS NOT NULL AND hidden=0 ORDER BY ordinal`)
    .all(...scope.prefix)) {
    scope.examined(row)
    const names: { id: string }[] = JSON.parse(String(row.subagent_names))
    for (const { id } of names) {
      subagents.add(id)
    }
  }
  return { canonicalByToolUse: [...canonical], attemptByAgent: attempts, subagents: [...subagents] }
}
