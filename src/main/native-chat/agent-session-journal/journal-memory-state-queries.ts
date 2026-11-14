import { memoryJournalMap, memoryJournalSet } from './journal-memory-collections'
import type { JournalStateQueries } from './journal-state-queries'
import { latestAgentSessionContextClearSequence } from '../../../shared/agent-session/agent-session-context-clear'
import { newestStructuredAgentSessionTurnBySequence } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { memoryJournalEchoClaimant } from './projection/journal-item-echo'
import { memoryLatestAcceptedSendUnopened } from './context-epochs/journal-stop-turn-end'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import { journalInputPresentationMember } from './input-order/journal-input-obligations'
import { readJournalUsageLimitContinueIdentity } from './journal-status-cuts'
import {
  journalTimelineContextWindowHeld,
  newestJournalTimelineTurn,
  unsettledJournalTimelineItems
} from './writing/journal-timeline-view'
import type { JournalReducerState } from './projection/journal-reducer'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

function* presentedItems(state: JournalReducerState) {
  for (const item of memoryJournalMap(state.items).values()) {
    if (journalInputPresentationMember(state, item.itemId)) {
      yield item
    }
  }
}

export const memoryJournalStateQueries: JournalStateQueries = {
  usageLimitContinueIdentity: readJournalUsageLimitContinueIdentity,
  latestContextClearSequence(state) {
    return latestAgentSessionContextClearSequence(memoryJournalMap(state.items).values())
  },
  echoClaimant: memoryJournalEchoClaimant,
  *itemsAfterSequence(state, sequence) {
    for (const item of memoryJournalMap(state.items).values()) {
      if (item.sequence > sequence) {
        yield item
      }
    }
  },
  *aliasesForSubmission(state, itemId) {
    for (const [provider, native] of memoryJournalMap(state.aliases)) {
      if (native === itemId) {
        yield provider
      }
    }
  },
  candidatesForFence(state, fence) {
    return [...memoryJournalMap(state.inputs.candidates).values()].filter(
      (send) =>
        (state.inputs.handovers.get(send.clientMessageId)?.fence ??
          state.inputs.sources.get(send.clientMessageId)?.fence ??
          send.fence) === fence
    )
  },
  *candidatesForHandoverFence(state, fence) {
    for (const send of memoryJournalMap(state.inputs.candidates).values()) {
      if (state.inputs.handovers.get(send.clientMessageId)?.fence === fence) {
        yield send
      }
    }
  },
  returnedCommandIds(state) {
    return memoryJournalSet(state.queue.returnedCommands).values()
  },
  latestAcceptedUnopened: memoryLatestAcceptedSendUnopened,
  newestTurnBySequence(state) {
    return newestStructuredAgentSessionTurnBySequence(memoryJournalMap(state.items).values())
  },
  latestItemForTurn(state, turnId) {
    let latest: ReturnType<JournalStateQueries['latestItemForTurn']> = null
    for (const item of memoryJournalMap(state.items).values()) {
      if (
        readAgentJournalTurn(item.body)?.turnId === turnId &&
        journalInputPresentationMember(state, item.itemId) &&
        (!latest || compareAgentJournalItems(item, latest) >= 0)
      ) {
        latest = item
      }
    }
    return latest
  },
  newestTurnItem: (state) => newestJournalTimelineTurn(presentedItems(state)),
  *itemsWithKeyPrefix(state, prefix) {
    for (const item of presentedItems(state)) {
      if (item.itemId.startsWith(prefix)) {
        yield item
      }
    }
  },
  newestItemWithKeyPrefix(state, prefix) {
    let newest: AgentJournalRenderItem | null = null
    for (const item of presentedItems(state)) {
      if (item.itemId.startsWith(prefix) && (!newest || item.sequence > newest.sequence)) {
        newest = item
      }
    }
    return newest
  },
  contextWindowHeld: (state) => journalTimelineContextWindowHeld(presentedItems(state)),
  unsettledItems: (state, turnItemId) =>
    unsettledJournalTimelineItems(presentedItems(state), turnItemId),
  oldestAppliedSettlementId(state) {
    return memoryJournalSet(state.appliedSettlementIds).values().next().value
  },
  nativeInputEntries(state) {
    return memoryJournalMap(state.inputEntries).entries()
  },
  nativeInputCards(state) {
    return memoryJournalMap(state.inputCards).entries()
  },
  queueCardsForInitialization(state) {
    return memoryJournalMap(state.queue.cards).values()
  }
}
