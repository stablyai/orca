import type { JournalReducerState } from './journal-reducer'
import { durableQueuePauseMarks } from './journal-outcome-format-1-decode'

/** The whole chat in a comparable form, insertion order included: a restore must equal live. */
export function encodeJournalState(state: JournalReducerState): {
  stateJson: string
  items: { itemId: string; itemJson: string; ordinal: number }[]
} {
  const stored = {
    sessionId: state.sessionId,
    epoch: state.epoch,
    lastSequence: state.lastSequence,
    lastActivityAt: state.lastActivityAt,
    oldestSequence: state.oldestSequence,
    highestFence: state.highestFence,
    itemFences: [...state.itemFences],
    itemExecutionOwners: [...state.itemExecutionOwners],
    providerActivityAt: [...state.providerActivityAt],
    tombstones: [...state.tombstones],
    removedTurnIds: [...state.removedTurnIds],
    submissions: [...state.submissions],
    inputEntries: [...state.inputEntries],
    inputCards: [...state.inputCards],
    receipts: [...state.receipts],
    aliases: [...state.aliases],
    itemEchoes: [...state.itemEchoes].map(([key, value]) =>
      value === undefined ? [key] : [key, value]
    ),
    appliedSettlementIds: [...state.appliedSettlementIds],
    derivedTurnScope: state.derivedTurnScope.snapshot(),
    latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
    queuePauseMarks: durableQueuePauseMarks(state.queuePauseMarks),
    stoppedHistoryCarried: [...state.stoppedHistoryCarried],
    queuedHandOffPlaces: [...state.queuedHandOffPlaces],
    normalizedHandOffs: [...state.normalizedHandOffs],
    queue: { revision: state.queue.revision, cards: [...state.queue.cards] },
    historyOrigin: state.historyOrigin
  } satisfies Record<Exclude<keyof JournalReducerState, 'items'>, unknown>
  return {
    stateJson: JSON.stringify(stored),
    items: [...state.items].map(([itemId, item], ordinal) => ({
      itemId,
      itemJson: JSON.stringify(item),
      ordinal
    }))
  }
}
