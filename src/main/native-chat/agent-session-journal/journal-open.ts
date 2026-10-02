// Loading a journal: the session projection names the live epoch, and that
// epoch's rows are folded through the reducer in sequence order.
//
// There is no snapshot to anchor to and no superseded-epoch rows to drop — a
// roll deletes them in the same transaction that publishes the new epoch. A gap
// in the surviving sequence is corruption, and the caller rolls the epoch
// rather than rendering a partial timeline.

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
import { JOURNAL_REPAIR_DISCLOSURE_ITEM_ID } from './journal-repair-disclosure'
import { pendingJournalRepairSequence } from './journal-repair-marker'
import { isJournalStopOrResumeRow, parseJournalRow, type JournalRow } from './journal-row-schema'

/** Every epoch row is sequence 1, and no compaction moves that floor. */
const FIRST_JOURNAL_SEQUENCE = 1

export type JournalLoad = {
  state: JournalReducerState
  /** A row from a future schema, or of a kind this build does not know, was met: no writes, no
   *  deletion. */
  readOnly: boolean
  /** Set when the surviving prefix is unusable and the caller must roll the epoch. */
  corrupt: boolean
  /** Rows dropped because they failed to parse or name another sequence than their key (an
   *  unreadable row latches `readOnly`, never counted here). The store discloses these in the
   *  timeline. */
  malformedRows: number
  /** Directory-internal: the first sequence of an unusable suffix. The store
   *  deletes from here before it accepts a write; a probe leaves it alone. */
  truncateFrom?: number
}

/** Replays one chat from the host's database. Returns null when the chat has no journal yet. */
export function replayJournal(db: Database.Database, sessionId: string): JournalLoad | null {
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (epoch === null) {
    return null
  }
  return foldJournalRows({
    sessionId,
    epoch,
    repairedFrom: pendingJournalRepairSequence(db, sessionId, epoch),
    rows: iterateJournalEpochRows(db, sessionId, epoch)
  })
}

/** Folds one epoch's stored rows, in sequence order, wherever they are stored. */
function foldJournalRows(
  input: JournalRowFoldInput & { rows: Iterable<{ seq: number; rowJson: string }> }
): JournalLoad {
  const fold = startJournalRowFold(input)
  for (const entry of input.rows) {
    if (!fold.add(entry)) {
      break
    }
  }
  return fold.finish()
}

type JournalRowFoldInput = {
  sessionId: string
  epoch: string
  /** The sequence a pending repair on this epoch left free. */
  repairedFrom: number | null
}

/** The same fold, fed a row at a time, for a caller that yields between batches of rows. */
export function startJournalRowFold(input: JournalRowFoldInput): {
  /** False once the fold has stopped: the rest of the rows are not read. */
  add: (entry: { seq: number; rowJson: string }) => boolean
  finish: () => JournalLoad
} {
  const { repairedFrom } = input
  const state = createJournalReducerState(input.sessionId, input.epoch)
  let expectedSequence = FIRST_JOURNAL_SEQUENCE
  let gapSequence: number | undefined
  let unanchoredSequence: number | undefined
  let anchor: Extract<JournalRow, { kind: 'epoch' }> | undefined
  let repairHasContent = false
  let providerHasContent = false
  let malformedRows = 0
  let latched = false
  let truncateFrom: number | undefined

  const add = (entry: { seq: number; rowJson: string }): boolean => {
    const parsed = parseJournalRow(entry.rowJson)
    // A body naming another sequence than its key is malformed there: writes number past the key.
    if (!parsed.ok || parsed.row.seq !== entry.seq) {
      truncateFrom = entry.seq
      latched = !parsed.ok && parsed.unreadable
      malformedRows = latched ? 0 : 1
      return false
    }
    const row = parsed.row
    // Parse past a gap so an unreadable future row still latches read-only.
    if (gapSequence !== undefined) {
      return true
    }
    if (row.seq !== expectedSequence) {
      gapSequence = row.seq
      return true
    }
    expectedSequence += 1
    if (row.seq === FIRST_JOURNAL_SEQUENCE) {
      if (row.kind === 'epoch') {
        anchor = row
      } else {
        unanchoredSequence = row.seq
      }
    }
    if (!anchor) {
      return true
    }
    applyJournalRow(state, row)
    const disclosure = row.kind === 'item' && row.itemId === JOURNAL_REPAIR_DISCLOSURE_ITEM_ID
    // A Stop or Resume is no history, so it never reads as a rebuilt or provider-backed epoch.
    if (!disclosure && !isJournalStopOrResumeRow(row)) {
      repairHasContent ||= repairedFrom !== null && row.seq >= repairedFrom
      providerHasContent ||= row.seq >= FIRST_JOURNAL_SEQUENCE + 1
    }
    return true
  }
  const finish = (): JournalLoad => {
    // Anchor rejection takes precedence over a gap, which takes precedence over malformed rows.
    truncateFrom = unanchoredSequence ?? gapSequence ?? truncateFrom
    state.oldestSequence = FIRST_JOURNAL_SEQUENCE
    return {
      state,
      readOnly: latched,
      corrupt:
        gapSequence !== undefined ||
        malformedRows > 0 ||
        (!latched && !anchor) ||
        (repairedFrom !== null && !repairHasContent) ||
        (anchor?.reason === 'unreconcilable_prefix' && !providerHasContent),
      malformedRows,
      ...(truncateFrom !== undefined && !latched ? { truncateFrom } : {})
    }
  }
  return { add, finish }
}

/** Rows after a cursor, in sequence order. Stops at the first row this build
 *  cannot parse, exactly as replay does. */
export function readJournalRowsAfterCursor(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSequence: number,
  limit?: number
): JournalRow[] {
  const rows: JournalRow[] = []
  for (const stored of readJournalRowsAfter(db, sessionId, epoch, afterSequence, limit)) {
    const parsed = parseJournalRow(stored.rowJson)
    if (!parsed.ok) {
      break
    }
    rows.push(parsed.row)
  }
  return rows
}
