import type { z } from 'zod'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import {
  outcomeFormat1EntryParsers,
  outcomeFormat1Fields,
  outcomeFormat1Scalars,
  outcomeFormat1StrictScalars
} from './journal-outcome-format-1'

// Part of frozen outcome format 1: builds reducer state from its stored scalars and keyed entries.

type JournalStateDecode = {
  entry: (path: string, entryJson: string) => void
  has: (path: string, key: unknown) => boolean
  remove: (path: string, key: unknown) => void
  finish: () => JournalReducerState
}

type Target = {
  set: (entry: unknown) => void
  has: (key: unknown) => boolean
  remove: (key: unknown) => void
}

/** Applies stored scalars and entries onto `baseline`, or onto a new chat state when the scalars
 * are complete. A map or set entry for an existing key replaces it in place. */
export function decodeOutcomeFormat1Onto(
  scalarJson: readonly [string, string][],
  baseline?: JournalReducerState
): JournalStateDecode {
  const state = baseline ?? createJournalReducerState('', '')
  if (!baseline) {
    outcomeFormat1StrictScalars.parse(
      Object.fromEntries(scalarJson.map(([key, json]) => [key, JSON.parse(json)]))
    )
  }
  for (const [key, json] of scalarJson) {
    applyScalar(state, key, JSON.parse(json))
  }
  const targets = collectionTargets(state)
  const target = (path: string): Target => {
    const found = targets.get(path)
    if (!found) {
      throw new Error('unknown saved journal collection')
    }
    return found
  }
  return {
    entry: (path, entryJson) => target(path).set(JSON.parse(entryJson)),
    has: (path, key) => target(path).has(key),
    remove: (path, key) => target(path).remove(key),
    finish: () => state
  }
}

// Live Stop settlement belongs to its process; only the row-derived pause facts are stored, so a
// stored value decodes as it is.
export function durableQueuePauseMarks(
  marks: JournalReducerState['queuePauseMarks']
): JournalReducerState['queuePauseMarks'] {
  const stop = marks.latestStop
  return { ...marks, latestStop: stop && { sequence: stop.sequence, event: stop.event } }
}

function applyScalar(state: JournalReducerState, key: string, value: unknown): void {
  const f = outcomeFormat1Scalars.shape
  switch (key) {
    case 'sessionId':
      state.sessionId = f.sessionId.parse(value)
      return
    case 'epoch':
      state.epoch = f.epoch.parse(value)
      return
    case 'lastSequence':
      state.lastSequence = f.lastSequence.parse(value)
      return
    case 'lastActivityAt':
      state.lastActivityAt = f.lastActivityAt.parse(value)
      return
    case 'oldestSequence':
      state.oldestSequence = f.oldestSequence.parse(value)
      return
    case 'highestFence':
      state.highestFence = f.highestFence.parse(value)
      return
    case 'derivedTurnScope':
      state.derivedTurnScope = JournalDerivedTurnScope.restore(f.derivedTurnScope.parse(value))
      return
    case 'latestAcceptedTurnSequence':
      state.latestAcceptedTurnSequence = f.latestAcceptedTurnSequence.parse(value)
      return
    case 'queuePauseMarks':
      state.queuePauseMarks = f.queuePauseMarks.parse(value)
      return
    case 'queue':
      state.queue.revision = f.queue.parse(value).revision
      return
    case 'historyOrigin':
      state.historyOrigin = f.historyOrigin.parse(value)
      return
    default:
      throw new Error('unknown saved journal scalar')
  }
}

const isString = (key: unknown): key is string => typeof key === 'string'
const isNumber = (key: unknown): key is number => typeof key === 'number'

function collectionTargets(state: JournalReducerState): Map<string, Target> {
  const map = <K, V>(
    target: Map<K, V>,
    schema: z.ZodType<[K, V]>,
    isKey: (key: unknown) => key is K
  ): Target => ({
    set: (entry) => {
      const [key, value] = schema.parse(entry)
      target.set(key, value)
    },
    has: (key) => isKey(key) && target.has(key),
    remove: (key) => {
      if (isKey(key)) {
        target.delete(key)
      }
    }
  })
  const set = (target: Set<string>, schema: z.ZodType<[string, string]>): Target => ({
    set: (entry) => {
      target.add(schema.parse(entry)[0])
    },
    has: (key) => isString(key) && target.has(key),
    remove: (key) => {
      if (isString(key)) {
        target.delete(key)
      }
    }
  })
  const p = outcomeFormat1EntryParsers
  const items = state.items
  return new Map<string, Target>([
    [
      'items',
      {
        set: (entry) => {
          const item = outcomeFormat1Fields.items.element.parse(entry)
          items.set(item.itemId, item)
        },
        has: (key) => isString(key) && items.has(key),
        remove: (key) => {
          if (isString(key)) {
            items.delete(key)
          }
        }
      }
    ],
    ['itemFences', map(state.itemFences, p.itemFences, isString)],
    ['itemExecutionOwners', map(state.itemExecutionOwners, p.itemExecutionOwners, isString)],
    ['providerActivityAt', map(state.providerActivityAt, p.providerActivityAt, isNumber)],
    ['tombstones', map(state.tombstones, p.tombstones, isString)],
    ['removedTurnIds', set(state.removedTurnIds, p.removedTurnIds)],
    ['submissions', map(state.submissions, p.submissions, isString)],
    ['receipts', map(state.receipts, p.receipts, isString)],
    ['aliases', map(state.aliases, p.aliases, isString)],
    [
      'itemEchoes',
      {
        set: (entry) => {
          const echo = p.itemEchoes.parse(entry)
          state.itemEchoes.set(echo[0], echo[1])
        },
        has: (key) => isString(key) && state.itemEchoes.has(key),
        remove: (key) => {
          if (isString(key)) {
            state.itemEchoes.delete(key)
          }
        }
      }
    ],
    ['appliedSettlementIds', set(state.appliedSettlementIds, p.appliedSettlementIds)],
    ['stoppedHistoryCarried', map(state.stoppedHistoryCarried, p.stoppedHistoryCarried, isString)],
    ['queuedHandOffPlaces', map(state.queuedHandOffPlaces, p.queuedHandOffPlaces, isString)],
    ['normalizedHandOffs', set(state.normalizedHandOffs, p.normalizedHandOffs)],
    ['queue.cards', map(state.queue.cards, p['queue.cards'], isString)]
  ])
}
