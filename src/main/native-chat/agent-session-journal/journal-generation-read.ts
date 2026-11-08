import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import type { JournalSqlScope } from './journal-sql-scope'
import { readJournalDomainGeneration } from './journal-domain-generation-reads'

export type JournalGenerationRead = {
  startKey?: string
  stopSettle?: JournalStopSettleFact
  exitScope?: { completedAt: number; ownerFence: number }
  /** Prior unfinished identities may now be settled and outside the eligible lifecycle index. */
  itemIds?: readonly string[]
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
    items: [...items.values()],
    submissions: generation.submissions(),
    itemFences: [...items.keys()].map((itemId) => [itemId, generation.itemFence(itemId)]),
    stop: generation.stopMarks.latest()
  }
}
