// Replay live epochs without rewriting history; damage/newer rows fail load and remain on disk.

import { journalOutcomeSource } from './journal-outcome-format'
import { readJournalOutcomes } from './journal-outcome-table'
import { JournalOutcomeDecodeError } from './journal-outcome-codec'
import { readJournalOutcomeGroups, type JournalReadRow } from './journal-read-row'
import { AgentSessionJournalError } from './journal-write-guards'
import type Database from '../../sqlite/sync-database'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import {
  iterateJournalEpochRows,
  readJournalRowsAfter,
  readJournalSessionEpoch
} from './journal-row-table'
import { parseJournalRow } from './journal-row-schema'

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
export function restoreJournal(db: Database.Database, sessionId: string): JournalLoad | null {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    return null
  }
  const empty = createJournalReducerState(sessionId, epoch)
  try {
    const source = journalOutcomeSource(db, sessionId, epoch)
    if (!source) {
      return foldJournalFromState(db, empty)
    }
    let baseline: JournalReducerState | undefined
    if (source.prefix > 0) {
      const prefix = foldJournalFromState(db, empty, source.prefix)
      if (prefix.newer || prefix.damage || prefix.state.lastSequence !== source.prefix) {
        const gap = { sequence: prefix.state.lastSequence + 1, cause: 'sequence-gap' as const }
        return { ...prefix, damage: prefix.newer ? null : (prefix.damage ?? gap) }
      }
      baseline = prefix.state
    }
    const state = readJournalOutcomes(db, sessionId, epoch, source, baseline)
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
  through = Number.POSITIVE_INFINITY
): JournalLoad {
  const { sessionId, epoch, lastSequence } = state
  const fold = startJournalRowFold({ sessionId, epoch }, state)
  for (const entry of iterateJournalEpochRows(
    db,
    sessionId,
    epoch,
    lastSequence === 0 ? Number.MIN_SAFE_INTEGER : lastSequence
  )) {
    if (entry.seq > through || !fold.add(entry)) {
      break
    }
  }
  return fold.finish()
}

/** untilDamage stops at the first damage, for callers that only ask whether a fold publishes. */
export function startJournalRowFold(
  input: { sessionId: string; epoch: string; untilDamage?: boolean },
  state = createJournalReducerState(input.sessionId, input.epoch)
): {
  add: (entry: { seq: number; rowJson: string; ts?: number }) => boolean
  finish: () => JournalLoad
} {
  let expectedSequence = state.lastSequence + 1
  let damage: JournalDamage | null = null
  let anchored = state.lastSequence > 0
  let newer: { sequence: number } | null = null
  let empty = true

  const add = (entry: { seq: number; rowJson: string; ts?: number }): boolean => {
    empty = false
    const parsed = parseJournalRow(entry.rowJson)
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
    applyJournalRow(state, row, entry.ts)
    return true
  }
  const finish = (): JournalLoad => {
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

export function journalRowsAfterReader(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  limit?: number
): (afterSequence: number) => JournalReadRow[] {
  return (afterSequence) => readJournalRowsAfterCursor(db, sessionId, epoch, afterSequence, limit)
}

/** Stop replay at the first unreadable row; never serve a partial tail beyond it. A chat with an
 * input prefix pages its rows, then its outcome groups, each sequence exactly once. */
export function readJournalRowsAfterCursor(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSequence: number,
  limit?: number
): JournalReadRow[] {
  const source = journalOutcomeSource(db, sessionId, epoch)
  const prefix = source ? source.prefix : Number.POSITIVE_INFINITY
  const rows: JournalReadRow[] = []
  if (afterSequence < prefix) {
    for (const stored of readJournalRowsAfter(db, sessionId, epoch, afterSequence, limit)) {
      const parsed = stored.seq <= prefix ? parseJournalRow(stored.rowJson) : null
      if (!parsed?.ok) {
        // An unreadable prefix row ends the page; outcome groups never skip past it.
        return parsed ? rows : [...rows, ...groupsAfter(prefix)]
      }
      rows.push(parsed.row)
    }
    if (!source || (limit !== undefined && rows.length >= limit)) {
      return rows
    }
  }
  return [...rows, ...groupsAfter(Math.max(afterSequence, prefix))]

  function groupsAfter(after: number): JournalReadRow[] {
    return source
      ? readJournalOutcomeGroups(
          db,
          epoch,
          source,
          after,
          limit === undefined ? undefined : limit - rows.length
        )
      : []
  }
}
