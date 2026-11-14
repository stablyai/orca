import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import type { JournalSqlScope } from './journal-sql-scope'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { readJournalDomainGeneration } from './journal-domain-generation-reads'

export type JournalGenerationRead = {
  startKey?: string
  stopSettle?: JournalStopSettleFact
  exitScope?: { completedAt: number; ownerFence: number }
  /** Prior unfinished identities may now be settled and outside the eligible lifecycle index. */
  itemIds?: readonly string[]
  teardownAnchors?: boolean
}

export type JournalGenerationResult = {
  cursor: AgentJournalCursor
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
  itemFences: [string, number | undefined][]
  stop: JournalLatestStop | null
}

/** Materialize only lifecycle obligations and explicitly named prior observations in one snapshot. */
export function readJournalGeneration(
  scope: JournalSqlScope,
  input: JournalGenerationRead
): JournalGenerationResult {
  const generation = readJournalDomainGeneration(
    scope.db,
    { sessionId: scope.sessionId, epoch: scope.epoch },
    input.startKey,
    input.stopSettle,
    input.exitScope
  )
  const items = new Map(generation.snapshot().items.map((item) => [item.itemId, item]))
  if (input.teardownAnchors) {
    const anchor = scope.db
      .prepare(`SELECT payload_json FROM journal_items
      INDEXED BY journal_items_teardown_turn WHERE session_id=? AND epoch=? AND hidden=0
      AND root=1 AND turn_id IS NOT NULL AND queue_command_turn=0
      ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1`)
      .get(...scope.prefix)
    if (anchor) {
      const item = scope.decode<AgentJournalRenderItem>(anchor.payload_json)
      items.set(item.itemId, item)
      const turn = readAgentJournalTurn(item.body)
      if (turn?.userItemId) {
        const opener = scope.db
          .prepare(`SELECT payload_json FROM journal_items
          WHERE session_id=? AND epoch=? AND hidden=0 AND item_id=?`)
          .get(...scope.prefix, turn.userItemId)
        if (opener) {
          const user = scope.decode<AgentJournalRenderItem>(opener.payload_json)
          items.set(user.itemId, user)
        }
      }
    }
    const user = scope.db
      .prepare(`SELECT payload_json FROM journal_items
      INDEXED BY journal_items_status_prompt WHERE session_id=? AND epoch=? AND hidden=0
      AND prompt=1 ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1`)
      .get(...scope.prefix)
    if (user) {
      const item = scope.decode<AgentJournalRenderItem>(user.payload_json)
      items.set(item.itemId, item)
    }
  }
  for (const itemId of input.itemIds ?? []) {
    const row = scope.db
      .prepare(
        `SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0 AND item_id=?`
      )
      .get(...scope.prefix, itemId)
    if (row) {
      const item: AgentJournalRenderItem = JSON.parse(String(row.payload_json))
      items.set(item.itemId, item)
    }
  }
  return {
    cursor: generation.cursor(),
    items: [...items.values()].sort(
      (a, b) =>
        a.sequence - b.sequence ||
        (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0) ||
        a.itemId.localeCompare(b.itemId)
    ),
    submissions: generation.submissions(),
    itemFences: [...items.keys()].map((itemId) => [itemId, generation.itemFence(itemId)]),
    stop: generation.stopMarks.latest()
  }
}
