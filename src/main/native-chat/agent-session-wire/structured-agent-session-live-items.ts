import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalAppendResult } from '../agent-session-journal/journal-store-contracts'

// Only provider-sink commits establish current activity; imports use the same writer fence.
const liveItems = new WeakMap<
  AgentSessionJournal,
  Map<string, { epoch: string; fence: number; revision: number }>
>()

export function recordStructuredSessionLiveItem(
  journal: AgentSessionJournal,
  fence: number,
  body: AgentJournalItemBody,
  result: JournalAppendResult
): void {
  const turn = readAgentJournalTurn(body)
  const active =
    turn !== null ||
    ((body.kind === 'approval' || body.kind === 'question') && body.resolution.state === 'pending')
  const items = liveItems.get(journal) ?? new Map()
  if (active) {
    items.set(result.itemId, { epoch: result.cursor.epoch, fence, revision: result.revision })
  } else {
    items.delete(result.itemId)
  }
  liveItems.set(journal, items)
}

export function currentStructuredSessionLiveItems(
  journal: AgentSessionJournal,
  fence: number,
  items: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem[] {
  const evidence = liveItems.get(journal)
  const epoch = journal.cursor().epoch
  return items.filter((item) => {
    const live = evidence?.get(item.itemId)
    return live?.epoch === epoch && live.fence === fence && live.revision === item.revision
  })
}

export function recordStructuredSessionLiveBatch(
  journal: AgentSessionJournal,
  fence: number,
  mutations: readonly JournalLifecycleMutationInput[],
  cursor: AgentJournalCursor
): void {
  const items = new Map(journal.snapshot().items.map((item) => [item.itemId, item]))
  for (const mutation of mutations) {
    const itemId = journal.canonicalItemId(agentJournalItemKey(mutation.identity))
    const item = items.get(itemId)
    if (mutation.kind === 'tombstone') {
      liveItems.get(journal)?.delete(itemId)
    } else if (item && JSON.stringify(item.body) === JSON.stringify(mutation.body)) {
      recordStructuredSessionLiveItem(journal, fence, item.body, {
        itemId,
        revision: item.revision,
        cursor
      })
    }
  }
}
