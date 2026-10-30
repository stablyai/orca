import type { z } from 'zod'
import type { JournalReducerState } from './journal-reducer'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import {
  outcomeFormat1EntryParsers,
  outcomeFormat1Fields,
  outcomeFormat1Scalars
} from './journal-outcome-format-1'

// Part of frozen outcome format 1: builds reducer state from its stored scalars and keyed entries.

export type JournalStateDecode = {
  item: (itemJson: string) => void
  entry: (path: string, entryJson: string) => void
  finish: () => JournalReducerState
}

/** Decodes format 1's scalars, then its keyed entries in their stored order. */
export function startOutcomeFormat1Decode(scalars: unknown): JournalStateDecode {
  const state = journalStateFromFormat1(outcomeFormat1Scalars.parse(scalars))
  const targets = collectionTargets(state)
  return {
    item: (itemJson) => {
      const item = outcomeFormat1Fields.items.element.parse(JSON.parse(itemJson))
      state.items.set(item.itemId, item)
    },
    entry: (path, entryJson) => {
      const target = targets.get(path)
      if (!target) {
        throw new Error('unknown saved journal collection')
      }
      target(JSON.parse(entryJson))
    },
    finish: () => state
  }
}

// Live Stop settlement belongs to its process; only the row-derived pause facts survive restart.
export function durableQueuePauseMarks(
  marks: JournalReducerState['queuePauseMarks']
): JournalReducerState['queuePauseMarks'] {
  const stop = marks.latestStop
  return { ...marks, latestStop: stop && { sequence: stop.sequence, event: stop.event } }
}

function journalStateFromFormat1(
  stored: z.infer<typeof outcomeFormat1Scalars>
): JournalReducerState {
  return {
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
}

function collectionTargets(state: JournalReducerState): Map<string, (entry: unknown) => void> {
  const map =
    <K, V>(target: Map<K, V>, schema: z.ZodType<[K, V]>) =>
    (entry: unknown): void => {
      const [key, value] = schema.parse(entry)
      target.set(key, value)
    }
  const set =
    <T>(target: Set<T>, schema: z.ZodType<[T]>) =>
    (entry: unknown): void => {
      target.add(schema.parse(entry)[0])
    }
  const p = outcomeFormat1EntryParsers
  return new Map<string, (entry: unknown) => void>([
    ['itemFences', map(state.itemFences, p.itemFences)],
    ['itemExecutionOwners', map(state.itemExecutionOwners, p.itemExecutionOwners)],
    ['providerActivityAt', map(state.providerActivityAt, p.providerActivityAt)],
    ['tombstones', map(state.tombstones, p.tombstones)],
    ['removedTurnIds', set(state.removedTurnIds, p.removedTurnIds)],
    ['submissions', map(state.submissions, p.submissions)],
    ['receipts', map(state.receipts, p.receipts)],
    ['aliases', map(state.aliases, p.aliases)],
    [
      'itemEchoes',
      (entry) => {
        const echo = p.itemEchoes.parse(entry)
        state.itemEchoes.set(echo[0], echo[1])
      }
    ],
    ['appliedSettlementIds', set(state.appliedSettlementIds, p.appliedSettlementIds)],
    ['stoppedHistoryCarried', map(state.stoppedHistoryCarried, p.stoppedHistoryCarried)],
    ['queuedHandOffPlaces', map(state.queuedHandOffPlaces, p.queuedHandOffPlaces)],
    ['normalizedHandOffs', set(state.normalizedHandOffs, p.normalizedHandOffs)],
    ['queue.cards', map(state.queue.cards, p['queue.cards'])]
  ])
}
