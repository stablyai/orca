import {
  restoreHistoricalPersonAcceptance,
  restoredJournalPersonAcceptance
} from './journal-historical-inputs'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { restoreRetainedJournalInputs } from './journal-retained-inputs'
import { readJournalLegacyCards } from '../queued-messages/journal-queue-import'
import { journalInputOrder } from '../input-order/journal-input-order'
import { journalOutcomeSource } from '../outcomes/journal-outcome-format'
import { readJournalOutcomes } from '../outcomes/journal-outcome-table'
import {
  JournalOutcomeDecodeError,
  AgentSessionJournalError
} from '../writing/journal-write-guards'

import {
  applyJournalRow,
  applyMarker5JournalRow,
  createJournalReducerState,
  type JournalReducerState
} from '../projection/journal-reducer'
import { iterateJournalEpochRows, readJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { parseJournalRow } from '../durable-rows/journal-row-schema'

import type Database from '../../../sqlite/sync-database'
import type { JournalOutcomeReadOptions } from '../outcomes/journal-outcome-table'

/** The physical anchor is sequence 1; later epoch rows are context boundaries. */
const FIRST_JOURNAL_SEQUENCE = 1

export type JournalDamage = {
  sequence: number
  cause: 'unparseable-row' | 'misnumbered-row' | 'sequence-gap' | 'no-epoch-row'
}

export type JournalLoad = {
  state: JournalReducerState
  /** Future row versions/kinds require an updated reader. */
  newer: { sequence: number } | null
  /** Newer content outranks adjacent damage. */
  damage: JournalDamage | null
}

export function replayJournal(db: Database.Database, sessionId: string): JournalLoad | null {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    return null
  }
  return foldJournalFromState(db, createJournalReducerState(sessionId, epoch))
}

/** The read is synchronous, like main's replay: it blocks once for one chat's saved records (its
 * frozen input prefix, then each outcome key's newest record), and nothing can interleave with it.
 * Admission comes first, so a newer chat is never folded. */
export function restoreJournal(
  db: Database.Database,
  sessionId: string,
  options?: JournalOutcomeReadOptions
): JournalLoad | null {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    return null
  }
  const empty = createJournalReducerState(sessionId, epoch)
  try {
    const source = journalOutcomeSource(db, sessionId, epoch)
    if (!source) {
      const loaded = foldJournalFromState(db, empty, Infinity, 'sources', false)
      if (!loaded.newer && !loaded.damage) {
        const personal = restoredJournalPersonAcceptance(db, loaded.state)
        const owner = journalInputOrder(loaded.state)
        for (const input of memoryJournalMap(loaded.state.submissions).values()) {
          if (input.dispatchState === 'accepted' && personal(input)) {
            owner.seedPersonAcceptance(input.acceptedSequence ?? 0)
          }
        }
      }
      return loaded
    }
    let baseline: JournalReducerState | undefined
    if (source.prefix > 0) {
      const prefix = foldJournalFromState(
        db,
        empty,
        source.prefix,
        source.marker === 5 ? 'marker5' : 'sources',
        true
      )
      if (prefix.newer || prefix.damage || prefix.state.lastSequence !== source.prefix) {
        const gap = { sequence: prefix.state.lastSequence + 1, cause: 'sequence-gap' as const }
        return { ...prefix, damage: prefix.newer ? null : (prefix.damage ?? gap) }
      }
      baseline = prefix.state
    }
    let acceptedPrefix = new Map<string, AgentJournalSubmission>()
    const prefixRevisions =
      baseline &&
      new Map(
        [...memoryJournalMap(baseline.submissions)].map(([id, submission]) => {
          if (submission.dispatchState === 'accepted') {
            acceptedPrefix.set(id, submission)
          }
          const key = agentJournalSubmissionKey(id)
          return [
            key,
            baseline.items.get(key)?.revision ?? baseline.tombstones.get(key) ?? 0
          ] as const
        })
      )
    const state = readJournalOutcomes(db, sessionId, epoch, source, baseline, options)
    if (source.marker === 5 && source.prefix > 0) {
      const observations = foldJournalFromState(
        db,
        createJournalReducerState(sessionId, epoch),
        source.prefix,
        'sources',
        false
      )
      if (observations.newer || observations.damage) {
        return observations
      }
      // Admission evidence cannot resurrect common keys retired by the frozen decoder or tail.
      state.inputs = observations.state.inputs
      state.inputs.candidates.clear()
      acceptedPrefix = memoryJournalMap(observations.state.submissions)
    }
    restoreRetainedJournalInputs(db, state, source, prefixRevisions, acceptedPrefix)
    restoreHistoricalPersonAcceptance(db, state, source)
    return { state, newer: null, damage: null }
  } catch (error) {
    if (error instanceof AgentSessionJournalError && error.code === 'journal_read_only') {
      return { state: empty, newer: { sequence: 1 }, damage: null }
    }
    // Only stored content this build rejects is damage; a storage error stays retryable, as on main.
    if (error instanceof JournalOutcomeDecodeError) {
      return { state: empty, newer: null, damage: { sequence: 1, cause: 'unparseable-row' } }
    }
    throw error
  }
}

/** Folds input rows as main does, up to `through` when the epoch's outcome records follow them. */
function foldJournalFromState(
  db: Database.Database,
  state: JournalReducerState,
  through = Number.POSITIVE_INFINITY,
  interpretation: 'marker5' | 'sources' = 'sources',
  deferNativeCleanup = false
): JournalLoad {
  const { sessionId, epoch, lastSequence } = state
  const fold = startJournalRowFold({ sessionId, epoch, interpretation, deferNativeCleanup }, state)
  const rows = iterateJournalEpochRows(
    db,
    sessionId,
    epoch,
    lastSequence === 0 ? Number.MIN_SAFE_INTEGER : lastSequence
  )
  for (const entry of rows) {
    if (entry.seq > through || !fold.add(entry)) {
      break
    }
  }
  if (!deferNativeCleanup) {
    journalInputOrder(state).overlay(state, readJournalLegacyCards(db, state))
  }
  return fold.finish()
}

/** untilDamage stops at the first damage, for callers that only ask whether a fold publishes. */
export function startJournalRowFold(
  input: {
    sessionId: string
    epoch: string
    untilDamage?: boolean
    interpretation?: 'marker5' | 'sources'
    deferNativeCleanup?: boolean
  },
  state = createJournalReducerState(input.sessionId, input.epoch)
): {
  add: (entry: { seq: number; rowJson: string; ts?: number }) => boolean
  finish: () => JournalLoad
} {
  journalInputOrder(state).beginReconstruction()
  let expectedSequence = state.lastSequence + 1
  let damage: JournalDamage | null = null
  let anchored = state.lastSequence > 0
  let newer: { sequence: number } | null = null
  let empty = true

  const add = (entry: { seq: number; rowJson: string; ts?: number }): boolean => {
    empty = false
    const parsed = parseJournalRow(entry.rowJson, input.interpretation === 'sources')
    if (!parsed.ok && parsed.unreadable) {
      newer = { sequence: entry.seq }
      return false
    }
    // Continue past damage to discover later rows requiring a newer reader.
    if (!parsed.ok) {
      damage ??= { sequence: entry.seq, cause: 'unparseable-row' }
      return true
    }
    // Key/body sequence mismatches would make future writes number against the wrong prefix.
    if (parsed.row.seq !== entry.seq) {
      damage ??= { sequence: entry.seq, cause: 'misnumbered-row' }
      return true
    }
    if (damage) {
      return true
    }
    const row = parsed.row
    if (row.seq !== expectedSequence) {
      const cause = expectedSequence === FIRST_JOURNAL_SEQUENCE ? 'no-epoch-row' : 'sequence-gap'
      damage = { sequence: expectedSequence, cause }
      return true
    }
    expectedSequence += 1
    if (row.seq === FIRST_JOURNAL_SEQUENCE && row.kind !== 'epoch') {
      damage = { sequence: row.seq, cause: 'no-epoch-row' }
      return true
    }
    anchored = true
    if (input.interpretation === 'marker5') {
      applyMarker5JournalRow(state, row, entry.ts)
    } else {
      applyJournalRow(state, row, entry.ts)
    }
    return true
  }
  const finish = (): JournalLoad => {
    if (!input.deferNativeCleanup) {
      journalInputOrder(state).finishReconstruction(state)
      journalInputOrder(state).legacy?.lineage.restoreFrontier(
        state.lastSequence,
        state.inputEntries
      )
    }
    state.oldestSequence = FIRST_JOURNAL_SEQUENCE
    // Empty epochs contain no recoverable history; founding a fresh epoch loses nothing.
    const found =
      damage ??
      (anchored || empty
        ? null
        : { sequence: FIRST_JOURNAL_SEQUENCE, cause: 'no-epoch-row' as const })
    return { state, newer, damage: newer ? null : found }
  }
  return { add: input.untilDamage ? (entry) => add(entry) && damage === null : add, finish }
}

import { memoryJournalMap } from '../journal-memory-collections'
