import { journalStateCollections } from './journal-state-layout'
import type { JournalReducerState } from './journal-reducer'
import { durableQueuePauseMarks } from './journal-outcome-format-1-decode'

/** The whole chat in a comparable form, insertion order included: a restore must equal live. */
export function encodeJournalState(state: JournalReducerState): {
  stateJson: string
  items: { itemId: string; itemJson: string; ordinal: number }[]
} {
  const collections = new Map(
    journalStateCollections(state).map(({ path, entries }) => [path, entries])
  )
  const entries = (path: string): [unknown, unknown][] => {
    const source = collections.get(path)
    if (!source) {
      throw new Error(`journal state snapshot requires collection ${path}`)
    }
    return [...source]
  }
  const stored = {
    sessionId: state.sessionId,
    epoch: state.epoch,
    lastSequence: state.lastSequence,
    lastActivityAt: state.lastActivityAt,
    oldestSequence: state.oldestSequence,
    ...(state.contextBoundary > 1 ? { contextBoundary: state.contextBoundary } : {}),
    highestFence: state.highestFence,
    itemFences: entries('itemFences'),
    itemExecutionOwners: entries('itemExecutionOwners'),
    providerActivityAt: entries('providerActivityAt'),
    tombstones: entries('tombstones'),
    removedTurnIds: entries('removedTurnIds').map(([id]) => id),
    submissions: [...state.submissions],
    inputEntries: [...state.inputEntries],
    inputCards: [...state.inputCards],
    receipts: entries('receipts'),
    aliases: [...state.aliases],
    itemEchoes: entries('itemEchoes').map(([key, value]) =>
      value === undefined ? [key] : [key, value]
    ),
    appliedSettlementIds: [...state.appliedSettlementIds],
    derivedTurnScope: state.derivedTurnScope.snapshot(),
    latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
    queuePauseMarks: durableQueuePauseMarks(state.queuePauseMarks),
    stoppedHistoryCarried: [...state.stoppedHistoryCarried],
    queuedHandOffPlaces: entries('queuedHandOffPlaces'),
    normalizedHandOffs: [...state.normalizedHandOffs],
    queue: { revision: state.queue.revision, cards: [...state.queue.cards] },
    historyOrigin: state.historyOrigin
  } satisfies Record<
    Exclude<keyof JournalReducerState, 'items' | 'inputs' | 'contextBoundary'>,
    unknown
  > & { contextBoundary?: number }
  return {
    stateJson: JSON.stringify(stored),
    items: [...state.items].map(([itemId, item], ordinal) => ({
      itemId,
      itemJson: JSON.stringify(item),
      ordinal
    }))
  }
}
