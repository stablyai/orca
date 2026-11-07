import { memoryJournalMap, memoryJournalSet } from './journal-memory-collections'
import type { JournalStateQueries } from './journal-state-queries'
import { latestAgentSessionContextClearSequence } from '../../../shared/agent-session/agent-session-context-clear'
import { newestStructuredAgentSessionTurnBySequence } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { memoryJournalEchoClaimant } from './projection/journal-item-echo'
import { memoryLatestAcceptedSendUnopened } from './context-epochs/journal-stop-turn-end'

export const memoryJournalStateQueries: JournalStateQueries = {
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
