import { z } from 'zod'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import {
  outcomeFormat1StoredScalars,
  outcomeFormat1StrictScalars
} from './journal-outcome-format-1'

// Part of frozen outcome format 1: builds reducer state from its stored scalars and keyed entries.
// Every value arrives as admission parsed it and walked it strictly, so these views only type it.

type JournalStateDecode = {
  entry: (path: string, entry: unknown) => void
  remove: (path: string, key: unknown) => void
  finish: () => JournalReducerState
}

type Target = {
  set: (entry: unknown) => void
  remove: (key: unknown) => void
}

/** Applies admitted scalars and entries onto `baseline`, or onto a new chat state when the scalars
 * are complete. A map or set entry for an existing key replaces it in place. */
export function decodeOutcomeFormat1Onto(
  scalars: readonly [string, unknown][],
  baseline?: JournalReducerState
): JournalStateDecode {
  const state = baseline ?? createJournalReducerState('', '')
  if (!baseline) {
    outcomeFormat1StrictScalars.parse(Object.fromEntries(scalars))
  }
  for (const [key, value] of scalars) {
    applyScalar(state, key, value)
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
    entry: (path, entry) => target(path).set(entry),
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

const f = outcomeFormat1StoredScalars.shape
const admittedPauseMarks = z.custom<JournalReducerState['queuePauseMarks']>()
const admittedHistoryOrigin = z.custom<JournalReducerState['historyOrigin']>()

function applyScalar(state: JournalReducerState, key: string, value: unknown): void {
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
      state.queuePauseMarks = admittedPauseMarks.parse(value)
      return
    case 'queue':
      state.queue.revision = f.queue.parse(value).revision
      return
    case 'historyOrigin':
      state.historyOrigin = admittedHistoryOrigin.parse(value)
      return
    default:
      throw new Error('unknown saved journal scalar')
  }
}

const isString = (key: unknown): key is string => typeof key === 'string'
const isNumber = (key: unknown): key is number => typeof key === 'number'

function collectionTargets(state: JournalReducerState): Map<string, Target> {
  const map = <K, V>(target: Map<K, V>, isKey: (key: unknown) => key is K): Target => {
    const admitted = z.custom<[K, V]>()
    return {
      set: (entry) => {
        const [key, value] = admitted.parse(entry)
        target.set(key, value)
      },
      remove: (key) => {
        if (isKey(key)) {
          target.delete(key)
        }
      }
    }
  }
  const member = z.custom<[string, string]>()
  const set = (target: Set<string>): Target => ({
    set: (entry) => {
      target.add(member.parse(entry)[0])
    },
    remove: (key) => {
      if (isString(key)) {
        target.delete(key)
      }
    }
  })
  const item = z.custom<AgentJournalRenderItem>()
  const echo = z.custom<[string] | [string, unknown]>()
  const items = state.items
  return new Map<string, Target>([
    [
      'items',
      {
        set: (entry) => {
          const value = item.parse(entry)
          items.set(value.itemId, value)
        },
        remove: (key) => {
          if (isString(key)) {
            items.delete(key)
          }
        }
      }
    ],
    ['itemFences', map(state.itemFences, isString)],
    ['itemExecutionOwners', map(state.itemExecutionOwners, isString)],
    ['providerActivityAt', map(state.providerActivityAt, isNumber)],
    ['tombstones', map(state.tombstones, isString)],
    ['removedTurnIds', set(state.removedTurnIds)],
    ['submissions', map(state.submissions, isString)],
    ['receipts', map(state.receipts, isString)],
    ['aliases', map(state.aliases, isString)],
    [
      'itemEchoes',
      {
        set: (entry) => {
          const value = echo.parse(entry)
          state.itemEchoes.set(value[0], value[1])
        },
        remove: (key) => {
          if (isString(key)) {
            state.itemEchoes.delete(key)
          }
        }
      }
    ],
    ['appliedSettlementIds', set(state.appliedSettlementIds)],
    ['stoppedHistoryCarried', map(state.stoppedHistoryCarried, isString)],
    ['queuedHandOffPlaces', map(state.queuedHandOffPlaces, isString)],
    ['normalizedHandOffs', set(state.normalizedHandOffs)],
    ['queue.cards', map(state.queue.cards, isString)]
  ])
}
