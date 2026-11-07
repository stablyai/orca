import type { JournalReducerState } from './projection/journal-reducer'
import { journalInputOrder } from './input-order/journal-input-order'
import { memoryJournalMap } from './journal-memory-collections'
import { renderJournalStatusItem } from './projection/journal-public-read'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'

function firstInputItem(item: AgentJournalRenderItem | null, floor: number): boolean {
  return !!(
    item &&
    item.sequence > floor &&
    item.body.kind === 'message' &&
    item.body.role === 'user' &&
    isRootAgentJournalItem(item) &&
    item.body.command === undefined
  )
}

/** Seeds retain provider fallback; historical associations contribute only their native item. */
export function readJournalFirstInputId(
  state: JournalReducerState,
  start: number,
  floor: number,
  seeds: readonly AgentJournalSubmission[]
): string | null {
  const order = journalInputOrder(state)
  const ids = new Set(seeds.map((entry) => entry.clientMessageId))
  for (const id of state.queries.statusRelatedInputIds(state, start, floor)) {
    ids.add(id)
  }
  const candidates = [...ids]
    .filter((id) => order.inputOrdinal(id) >= start)
    .sort((a, b) => order.inputOrdinal(a) - order.inputOrdinal(b))
  for (const id of candidates) {
    const native = renderJournalStatusItem(state, agentJournalSubmissionKey(id))
    const providerId = native ? undefined : state.submissions.get(id)?.providerItemId
    const item = native ?? (providerId ? renderJournalStatusItem(state, providerId) : null)
    if (firstInputItem(item, floor)) {
      return id
    }
  }
  return null
}

export function* memoryStatusRelatedInputIds(
  state: JournalReducerState,
  start: number,
  floor: number
): Iterable<string> {
  const order = journalInputOrder(state)
  for (const raw of memoryJournalMap(state.items).values()) {
    const item = renderJournalStatusItem(state, raw.itemId)
    if (!item) {
      continue
    }
    const steer = order.latestSteerForItem(item.itemId)
    if (steer !== undefined) {
      yield steer
    }
    const input = order.inputForItem(item.itemId)
    if (
      input &&
      order.inputOrdinal(input.clientMessageId) >= start &&
      firstInputItem(item, floor)
    ) {
      yield input.clientMessageId
    }
  }
}
