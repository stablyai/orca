import type { JournalReducerState } from './journal-reducer'

// Every reducer field has a storage home; queue splits its revision from its keyed cards.
export const journalStateLayout = {
  sessionId: 'scalar',
  epoch: 'scalar',
  lastSequence: 'scalar',
  lastActivityAt: 'scalar',
  oldestSequence: 'scalar',
  highestFence: 'scalar',
  items: 'items',
  itemFences: 'map',
  itemExecutionOwners: 'map',
  providerActivityAt: 'map',
  tombstones: 'map',
  removedTurnIds: 'set',
  submissions: 'map',
  inputEntries: 'map',
  inputCards: 'map',
  receipts: 'map',
  aliases: 'map',
  itemEchoes: 'map',
  appliedSettlementIds: 'set',
  derivedTurnScope: 'scalar',
  latestAcceptedTurnSequence: 'scalar',
  queuePauseMarks: 'scalar',
  stoppedHistoryCarried: 'map',
  queuedHandOffPlaces: 'map',
  normalizedHandOffs: 'set',
  queue: 'queue',
  historyOrigin: 'scalar'
} as const satisfies Record<keyof JournalReducerState, 'scalar' | 'items' | 'map' | 'set' | 'queue'>

type ScalarKey = {
  [K in keyof typeof journalStateLayout]: (typeof journalStateLayout)[K] extends 'scalar' | 'queue'
    ? K
    : never
}[keyof typeof journalStateLayout]

type Collection = { path: string; entries: Iterable<[unknown, unknown]> }

export function journalStateScalars(state: JournalReducerState): string {
  const stop = state.queuePauseMarks.latestStop
  return JSON.stringify({
    sessionId: state.sessionId,
    epoch: state.epoch,
    lastSequence: state.lastSequence,
    lastActivityAt: state.lastActivityAt,
    oldestSequence: state.oldestSequence,
    highestFence: state.highestFence,
    derivedTurnScope: state.derivedTurnScope.snapshot(),
    latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
    queuePauseMarks: {
      ...state.queuePauseMarks,
      latestStop: stop && { sequence: stop.sequence, event: stop.event }
    },
    queue: { revision: state.queue.revision },
    historyOrigin: state.historyOrigin
  } satisfies Record<ScalarKey, unknown>)
}

export function journalStateCollections(state: JournalReducerState): Collection[] {
  return Object.entries(state).flatMap<Collection>(([path, value]) => {
    if (value instanceof Map) {
      return [{ path, entries: value }]
    }
    if (value instanceof Set) {
      return [{ path, entries: value.entries() }]
    }
    if (path === 'queue') {
      return [{ path: 'queue.cards', entries: state.queue.cards }]
    }
    return []
  })
}

/** Entry tuples preserve an undefined echo declaration without turning it into null. */
export function journalEntryJson(
  key: unknown,
  value: unknown,
  replacer?: (key: string, value: unknown) => unknown
): string {
  return JSON.stringify(value === undefined ? [key] : [key, value], replacer)
}
