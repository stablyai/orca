import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import { agentJournalLinkageFields } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import type Database from '../../../sqlite/sync-database'
import { readJournalStoredItem } from '../journal-stored-output-rows'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalThreadGoal
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { currentAgentSessionThreadGoalSourceBySequence } from '../../../../shared/agent-session/thread-goals/agent-session-thread-goal'

export type JournalThreadGoalSource = {
  goal: AgentJournalThreadGoal | null
  row: { identity: AgentJournalItemIdentity; text: string } | null
}

export function journalThreadGoalSource(
  items: Iterable<AgentJournalRenderItem>
): JournalThreadGoalSource {
  const source = currentAgentSessionThreadGoalSourceBySequence(items)
  const item = source?.item
  const identity = item ? parseAgentJournalItemKey(item.itemId) : null
  return {
    goal: source?.goal ?? null,
    row:
      source?.goal && item?.body.kind === 'status' && identity
        ? { identity, text: item.body.text }
        : null
  }
}

/** The newest transition wins; on equal sequence the earlier-admitted row, as a fold scan keeps it. */
export function readJournalSqlGoalRows(db: Database.Database, prefix: readonly [string, string]) {
  const row = db
    .prepare(`SELECT payload_json FROM journal_items INDEXED BY journal_items_goal_transition
    WHERE session_id=? AND epoch=? AND hidden=0 AND goal_transition=1
    ORDER BY sequence DESC, ordinal ASC LIMIT 1`)
    .get(...prefix)
  return row ? [readJournalStoredItem(db, prefix, row.payload_json)] : []
}

export function readJournalSqlRecoveryGoal(
  db: Database.Database,
  prefix: readonly [string, string]
) {
  const saved = readJournalSqlGoalRows(db, prefix)[0]
  const identity = saved && parseAgentJournalItemKey(saved.itemId)
  if (!saved || !identity) {
    return null
  }
  const owner = db
    .prepare(`SELECT owner_fence, execution_owner FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=?`)
    .get(...prefix, saved.itemId)!
  const item: JournalReplacementItem = {
    identity,
    body: saved.body,
    observedAt: saved.observedAt,
    turnScope: saved.turnScope ?? { kind: 'thread' },
    ...agentJournalLinkageFields(saved),
    ownerFence: Number(owner.owner_fence),
    ...(owner.execution_owner == null ? {} : { executionOwner: Number(owner.execution_owner) })
  }
  return { saved, item }
}
