// What bookkeeping no person waits on may write: the retry's visit, the queue's automatic drain,
// and an exit's own settlement and release. Each handle carries the writes such a path makes,
// every one passing `{ background: true }` (`JournalWriteOptions`), so another connection's lock
// fails it at once instead of holding the main thread for the busy timeout. The paths read through
// types without these writes, so none can reach a write that waits.

import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { JournalContextController } from '../agent-session-journal/journal-context-controller'
import type { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

const BACKGROUND = { background: true } as const

type Background = { readonly background: true }

/** A settlement's one write (`settleStructuredAgentSessionLeftovers`). */
export type BackgroundSettlementWrites = Pick<AgentSessionJournal, 'appendPlannedLifecycleBatch'> &
  Background

export type BackgroundJournalWrites = BackgroundSettlementWrites &
  Pick<
    AgentSessionJournal,
    'resolveDispatch' | 'appendSubmission' | 'markQueueReopen' | 'replaceEpochItems'
  > & {
    queuedMessages: Pick<JournalQueuedMessages, 'hold' | 'repairAndPrune' | 'settleOwed'>
    context: Pick<JournalContextController, 'rewind'>
  }

/** A lease release's one write. */
export type BackgroundLeaseWrites = Pick<AgentSessionRecordStore, 'transitionHandoff'> & Background

export type BackgroundStoreWrites = BackgroundLeaseWrites &
  Pick<AgentSessionRecordStore, 'recordOperationOutcome'>

export function backgroundSettlementWrites(
  journal: Pick<AgentSessionJournal, 'appendPlannedLifecycleBatch'>
): BackgroundSettlementWrites {
  return {
    ...BACKGROUND,
    appendPlannedLifecycleBatch: (input) =>
      journal.appendPlannedLifecycleBatch({ ...input, ...BACKGROUND })
  }
}

export function backgroundJournalWrites(journal: AgentSessionJournal): BackgroundJournalWrites {
  const { queuedMessages: queued, context } = journal
  return {
    ...backgroundSettlementWrites(journal),
    resolveDispatch: (input, hook) => journal.resolveDispatch({ ...input, ...BACKGROUND }, hook),
    appendSubmission: (input, consume, receipt) =>
      journal.appendSubmission(input, consume && { ...consume, ...BACKGROUND }, receipt),
    markQueueReopen: (fence, since) => journal.markQueueReopen(fence, since, BACKGROUND),
    replaceEpochItems: (reason, fence, items) =>
      journal.replaceEpochItems(reason, fence, items, BACKGROUND),
    queuedMessages: {
      hold: (input) => queued.hold({ ...input, ...BACKGROUND }),
      repairAndPrune: () => queued.repairAndPrune(BACKGROUND),
      settleOwed: () => queued.settleOwed(BACKGROUND)
    },
    context: {
      rewind: (floor, fence, items, receipt) =>
        context.rewind(floor, fence, items, receipt, BACKGROUND)
    }
  }
}

export function backgroundLeaseWrites(
  store: Pick<AgentSessionRecordStore, 'transitionHandoff'>
): BackgroundLeaseWrites {
  return {
    ...BACKGROUND,
    transitionHandoff: (sessionId, transition) =>
      store.transitionHandoff(sessionId, transition, BACKGROUND)
  }
}

export function backgroundStoreWrites(store: AgentSessionRecordStore): BackgroundStoreWrites {
  return {
    ...backgroundLeaseWrites(store),
    recordOperationOutcome: (args) => store.recordOperationOutcome(args, BACKGROUND)
  }
}
