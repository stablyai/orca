import type Database from '../../sqlite/sync-database'
import type { ClaudeJournalSnapshot } from '../../claude/subagents/claude-subagent-journaled-identities'
import {
  claudeBackgroundTaskIdentity,
  indexClaudeBackgroundTask,
  type ClaudeBackgroundTaskIndex
} from '../../claude/background-tasks/claude-background-task-identity'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalProducerLinkage } from '../../../shared/agent-session/journal/agent-session-journal-types'

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
  const parents = new Map<string, Map<string | undefined, AgentJournalProducerLinkage>>()
  for (const row of db
    .prepare(`SELECT placement_json FROM journal_items
    INDEXED BY journal_items_producer_attempt
    WHERE session_id=? AND epoch=? AND hidden=0 AND producer_agent_id IS NOT NULL
    ORDER BY ordinal`)
    .all(...prefix)) {
    const linkage: AgentJournalProducerLinkage = JSON.parse(String(row.placement_json))
    if (linkage.agentId === undefined || linkage.producerKind !== 'agent') {
      continue
    }
    const runs = parents.get(linkage.agentId) ?? new Map()
    runs.delete(linkage.providerParentRef)
    runs.set(linkage.providerParentRef, linkage)
    parents.set(linkage.agentId, runs)
  }
  const backgrounds = new Map<string, ClaudeBackgroundTaskIndex>()
  const keyPrefix = agentJournalItemKey(claudeBackgroundTaskIdentity(''))
  for (const row of db
    .prepare(`SELECT item.item_id, item.placement_json,
    json_extract(block.value,'$.taskId') AS task_id,
    json_extract(block.value,'$.parentToolUseId') AS tool_use_id
    FROM journal_items item, json_each(item.payload_json,'$.body.blocks') block
    WHERE item.session_id=? AND item.epoch=? AND item.hidden=0
      AND item.item_id>=? AND item.item_id<? AND item.kind='message'
      AND json_extract(block.value,'$.type')='background-task'
    ORDER BY item.ordinal, CAST(block.key AS INTEGER)`)
    .all(
      ...prefix,
      keyPrefix,
      keyPrefix.slice(0, -1) + String.fromCharCode(keyPrefix.charCodeAt(keyPrefix.length - 1) + 1)
    )) {
    const taskId = String(row.task_id)
    const index = backgrounds.get(taskId) ?? { aliases: new Map() }
    indexClaudeBackgroundTask(
      index,
      String(row.item_id),
      taskId,
      row.tool_use_id === null ? undefined : String(row.tool_use_id),
      JSON.parse(String(row.placement_json))
    )
    backgrounds.set(taskId, index)
  }
  return {
    canonicalByToolUse,
    attemptByAgent,
    subagents,
    parents: [...parents].map(([id, runs]) => [id, [...runs]]),
    backgrounds: [...backgrounds].map(([id, index]) => [
      id,
      {
        ...index,
        aliases: [...index.aliases]
      }
    ])
  }
}
