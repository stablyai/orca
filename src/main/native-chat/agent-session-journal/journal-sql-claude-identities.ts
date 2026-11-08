import type Database from '../../sqlite/sync-database'
import type { ClaudeJournalSnapshot } from '../../claude/claude-subagent-journaled-identities'

/** Selected scalars and name memberships only: the last alias per parent, the floored highest attempt, the roster. */
export function readJournalDomainClaudeIdentities(
  db: Database.Database,
  prefix: readonly [string, string]
): Omit<ClaudeJournalSnapshot, 'threadGoal'> {
  // SQLite returns the bare agent column from the MAX(ordinal) row of each group.
  const canonicalByToolUse = db
    .prepare(`SELECT producer_parent_ref, producer_agent_id, MAX(ordinal) AS ordinal
    FROM journal_items INDEXED BY journal_items_producer_parent
    WHERE session_id=? AND epoch=? AND hidden=0 AND producer_parent_ref IS NOT NULL
    GROUP BY producer_parent_ref ORDER BY ordinal`)
    .all(...prefix)
    .map((row): [string, string] => [
      String(row.producer_parent_ref),
      String(row.producer_agent_id)
    ])
  const attemptByAgent = db
    .prepare(`SELECT producer_agent_id, MAX(producer_attempt) AS attempt
    FROM journal_items INDEXED BY journal_items_producer_attempt
    WHERE session_id=? AND epoch=? AND hidden=0 AND producer_agent_id IS NOT NULL
    GROUP BY producer_agent_id`)
    .all(...prefix)
    .map((row): [string, number] => [
      String(row.producer_agent_id),
      Math.max(1, Number(row.attempt))
    ])
  const subagents = db
    .prepare(`SELECT name.subagent_id FROM journal_item_subagent_names name
    JOIN journal_items item ON item.session_id=name.session_id AND item.epoch=name.epoch
      AND item.item_id=name.item_id
    WHERE name.session_id=? AND name.epoch=? AND item.hidden=0
    GROUP BY name.subagent_id ORDER BY MIN(item.ordinal)`)
    .all(...prefix)
    .map((row) => String(row.subagent_id))
  return { canonicalByToolUse, attemptByAgent, subagents }
}
