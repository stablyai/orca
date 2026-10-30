import type { z } from 'zod'
import type { JournalReducerState } from './journal-reducer'
import type { journalStateLayout } from './journal-state-layout'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import { fields, scalarsV2 } from './journal-state-schema'

export const JOURNAL_STATE_CODEC_VERSION = 3

type CollectionPath =
  | {
      [K in keyof typeof journalStateLayout]: (typeof journalStateLayout)[K] extends 'map' | 'set'
        ? K
        : never
    }[keyof typeof journalStateLayout]
  | 'queue.cards'

// Live Stop settlement belongs to its process; only the row-derived pause facts survive restart.
function durableQueuePauseMarks(
  marks: JournalReducerState['queuePauseMarks']
): JournalReducerState['queuePauseMarks'] {
  const stop = marks.latestStop
  return { ...marks, latestStop: stop && { sequence: stop.sequence, event: stop.event } }
}

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

export type JournalStateDecode = {
  item: (itemJson: string) => void
  entry: (path: string, entryJson: string) => void
  finish: () => JournalReducerState
}

/** Cache codec mismatch triggers a rebuild; decode in pages so large views can rest. */
export function startJournalStateDecode(
  version: number,
  stateJson: string
): JournalStateDecode | null {
  if (version !== JOURNAL_STATE_CODEC_VERSION) {
    return null
  }
  const stored = scalarsV2.parse(JSON.parse(stateJson))
  const state: JournalReducerState = {
    sessionId: stored.sessionId,
    epoch: stored.epoch,
    lastSequence: stored.lastSequence,
    lastActivityAt: stored.lastActivityAt,
    oldestSequence: stored.oldestSequence,
    highestFence: stored.highestFence,
    items: new Map(),
    itemFences: new Map(),
    itemExecutionOwners: new Map(),
    providerActivityAt: new Map(),
    tombstones: new Map(),
    removedTurnIds: new Set(),
    submissions: new Map(),
    receipts: new Map(),
    aliases: new Map(),
    itemEchoes: new Map(),
    appliedSettlementIds: new Set(),
    derivedTurnScope: JournalDerivedTurnScope.restore(stored.derivedTurnScope),
    latestAcceptedTurnSequence: stored.latestAcceptedTurnSequence,
    queuePauseMarks: durableQueuePauseMarks(stored.queuePauseMarks),
    stoppedHistoryCarried: new Map(),
    queuedHandOffPlaces: new Map(),
    normalizedHandOffs: new Set(),
    queue: { revision: stored.queue.revision, cards: new Map() },
    historyOrigin: stored.historyOrigin
  }
  const collections = collectionDecoders(state)
  return {
    item: (itemJson) => {
      const item = fields.items.element.parse(JSON.parse(itemJson))
      state.items.set(item.itemId, item)
    },
    entry: (path, entryJson) => {
      const decode = collections.get(path)
      if (!decode) {
        throw new Error('unknown saved journal collection')
      }
      const entry: unknown = JSON.parse(entryJson)
      if (!Array.isArray(entry) || entry.length < 1 || entry.length > 2) {
        throw new Error('invalid saved journal entry')
      }
      decode(entry)
    },
    finish: () => state
  }
}

// Entry tuples hold [key, value] for maps and [value, value] for sets; echoes may omit an undefined value.
function collectionDecoders(state: JournalReducerState): Map<string, (entry: unknown[]) => void> {
  const map =
    <K, V>(target: Map<K, V>, schema: z.ZodType<[K, V]>) =>
    (entry: unknown[]): void => {
      const [key, value] = schema.parse(entry)
      target.set(key, value)
    }
  const set =
    <T>(target: Set<T>, schema: z.ZodType<T>) =>
    (entry: unknown[]): void => {
      target.add(schema.parse(entry[0]))
    }
  const decoders = {
    itemFences: map(state.itemFences, fields.itemFences.element),
    itemExecutionOwners: map(state.itemExecutionOwners, fields.itemExecutionOwners.element),
    providerActivityAt: map(state.providerActivityAt, fields.providerActivityAt.element),
    tombstones: map(state.tombstones, fields.tombstones.element),
    removedTurnIds: set(state.removedTurnIds, fields.removedTurnIds.element),
    submissions: map(state.submissions, fields.submissions.element),
    receipts: map(state.receipts, fields.receipts.element),
    aliases: map(state.aliases, fields.aliases.element),
    itemEchoes: (entry: unknown[]): void => {
      const echo = fields.itemEchoes.element.parse(entry)
      state.itemEchoes.set(echo[0], echo[1])
    },
    appliedSettlementIds: set(state.appliedSettlementIds, fields.appliedSettlementIds.element),
    stoppedHistoryCarried: map(state.stoppedHistoryCarried, fields.stoppedHistoryCarried.element),
    queuedHandOffPlaces: map(state.queuedHandOffPlaces, fields.queuedHandOffPlaces.element),
    normalizedHandOffs: set(state.normalizedHandOffs, fields.normalizedHandOffs.element),
    'queue.cards': map(state.queue.cards, fields.queue.shape.cards.element)
  } satisfies Record<CollectionPath, (entry: unknown[]) => void>
  return new Map(Object.entries(decoders))
}
