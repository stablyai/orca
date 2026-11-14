import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { JournalReducerState } from '../projection/journal-reducer'
import { readJournalInputItem } from '../input-order/journal-input-obligations'
import { journalItemLifecycleState } from '../journal-item-status-metadata'
import { lostLiveWorkJournalBody } from '../item-lifecycle/journal-subagent-liveness'
import { personStopDecidesTurn } from '../context-epochs/journal-stop-turn-end'
import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { spelledProviderTimelineItemKey } from '../../../../shared/provider-timeline-item-key'

/** Named selections a timeline resolution reads at its write position; never the whole chat. */
export type JournalTimelineView = {
  item(itemId: string): AgentJournalRenderItem | null
  itemBody(itemId: string): AgentJournalItemBody | null
  hasVisibleProviderItemKey(key: string): boolean
  /** The most recently written turn row. */
  newestTurn(): AgentJournalRenderItem | null
  newestWithKeyPrefix(prefix: string): AgentJournalRenderItem | null
  withKeyPrefix(prefix: string): Iterable<AgentJournalRenderItem>
  contextWindowHeld(): boolean
  /** Running turns and calls, pending prompts and live work in insertion order; null spans the chat. */
  unsettled(turnItemId: string | null): Iterable<AgentJournalRenderItem>
  /** A person's Stop, not the provider, ended this turn. */
  stopDecidesTurn(turnId: string, endedAt: number): boolean
}

/** Row-local, so SQL selects the same population by its indexed columns. */
export function isUnsettledJournalTimelineItem(body: AgentJournalItemBody): boolean {
  const state = journalItemLifecycleState(body)
  return state === 'running' || state === 'pending' || lostLiveWorkJournalBody(body) !== null
}

export function journalTimelineView(state: JournalReducerState): JournalTimelineView {
  const item = (itemId: string) => readJournalInputItem(state, itemId)
  return {
    item,
    itemBody: (itemId) => item(itemId)?.body ?? null,
    hasVisibleProviderItemKey: (key) =>
      hasProviderItemKey(state.queries.itemsWithKeyPrefix(state, 'legacy:'), key),
    newestTurn: () => state.queries.newestTurnItem(state),
    newestWithKeyPrefix: (prefix) => state.queries.newestItemWithKeyPrefix(state, prefix),
    withKeyPrefix: (prefix) => state.queries.itemsWithKeyPrefix(state, prefix),
    contextWindowHeld: () => state.queries.contextWindowHeld(state),
    unsettled: (turnItemId) => state.queries.unsettledItems(state, turnItemId),
    stopDecidesTurn: (turnId, endedAt) => personStopDecidesTurn(state, turnId, endedAt)
  }
}

/** For in-memory item populations: the reducer's memory queries and per-turn scratch overlays. */
export function journalTimelineItemsView(
  item: (itemId: string) => AgentJournalRenderItem | null,
  items: () => Iterable<AgentJournalRenderItem>,
  stopDecidesTurn: JournalTimelineView['stopDecidesTurn'] = () => false
): JournalTimelineView {
  return {
    item,
    itemBody: (itemId) => item(itemId)?.body ?? null,
    hasVisibleProviderItemKey: (key) => hasProviderItemKey(items(), key),
    newestTurn: () => newestJournalTimelineTurn(items()),
    withKeyPrefix: function* (prefix) {
      for (const item of items()) {
        if (item.itemId.startsWith(prefix)) {
          yield item
        }
      }
    },
    newestWithKeyPrefix: (prefix) => {
      let newest: AgentJournalRenderItem | null = null
      for (const item of items()) {
        if (item.itemId.startsWith(prefix) && (!newest || item.sequence > newest.sequence)) {
          newest = item
        }
      }
      return newest
    },
    contextWindowHeld: () => journalTimelineContextWindowHeld(items()),
    unsettled: (turnItemId) => unsettledJournalTimelineItems(items(), turnItemId),
    stopDecidesTurn
  }
}

function hasProviderItemKey(items: Iterable<AgentJournalRenderItem>, key: string): boolean {
  for (const item of items) {
    const identity = parseAgentJournalItemKey(item.itemId)
    if (
      identity?.provider === 'legacy' &&
      spelledProviderTimelineItemKey(identity.recordId) === key
    ) {
      return true
    }
  }
  return false
}

export function newestJournalTimelineTurn(
  items: Iterable<AgentJournalRenderItem>
): AgentJournalRenderItem | null {
  let found: AgentJournalRenderItem | null = null
  for (const item of items) {
    if (item.body.kind === 'turn' && (found === null || item.sequence >= found.sequence)) {
      found = item
    }
  }
  return found
}

export function journalTimelineContextWindowHeld(items: Iterable<AgentJournalRenderItem>): boolean {
  for (const item of items) {
    if (readAgentJournalTurn(item.body)?.contextUsage?.window !== undefined) {
      return true
    }
  }
  return false
}

export function* unsettledJournalTimelineItems(
  items: Iterable<AgentJournalRenderItem>,
  turnItemId: string | null
): Iterable<AgentJournalRenderItem> {
  for (const item of items) {
    if (
      (turnItemId === null ||
        (item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turnItemId)) &&
      isUnsettledJournalTimelineItem(item.body)
    ) {
      yield item
    }
  }
}
