// Loading a journal: the session projection names the live epoch, and that
// epoch's rows are folded through the reducer in sequence order.
//
// There is no snapshot to anchor to and no superseded-epoch rows to drop — a
// roll deletes them in the same transaction that publishes the new epoch. A gap
// in the surviving sequence is corruption, and the caller rolls the epoch
// rather than rendering a partial timeline.

import { existsSync } from 'node:fs'
import type Database from '../../sqlite/sync-database'
import { findSequenceGap } from './journal-cursor'
import { openJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './journal-reducer'
import {
  readJournalEpochRows,
  readJournalRowsAfter,
  readJournalSessionEpoch
} from './journal-row-table'
import { JOURNAL_REPAIR_DISCLOSURE_ITEM_ID } from './journal-repair-disclosure'
import { pendingJournalRepairSequence } from './journal-repair-marker'
import { parseJournalRow, type JournalRow } from './journal-row-schema'

/** Every epoch row is sequence 1, and no compaction moves that floor. */
const FIRST_JOURNAL_SEQUENCE = 1

export type JournalLoad = {
  state: JournalReducerState
  /** A future schema version was met: no writes, no deletion. */
  readOnly: boolean
  /** Set when the surviving prefix is unusable and the caller must roll the epoch. */
  corrupt: boolean
  /** Rows skipped because their body failed to parse (future-version rows are
   *  `readOnly`, never counted here). The store discloses these in the timeline. */
  malformedRows: number
  /** Directory-internal: the first sequence of an unusable suffix. The store
   *  deletes from here before it accepts a write; a probe leaves it alone. */
  truncateFrom?: number
}

/**
 * Replay on a connection this function does NOT own. Returns null when the
 * session has no journal yet.
 */
export function replayJournal(
  db: Database.Database,
  readOnly: boolean,
  sessionId: string
): JournalLoad | null {
  if (readOnly) {
    return emptyReadOnlyLoad(sessionId)
  }
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (!epoch) {
    return null
  }
  const state = createJournalReducerState(sessionId, epoch)
  const stored = readJournalEpochRows(db, sessionId, epoch)
  // A partial repair keeps its prefix, so the surviving rows look contiguous and
  // anchored however much of the timeline it deleted. Its marker is what still
  // says otherwise, naming the sequence past which the epoch would be its own
  // history again.
  const repairedFrom = pendingJournalRepairSequence(db, sessionId, epoch)
  const rows: JournalRow[] = []
  let malformedRows = 0
  let latched = false
  let truncateFrom: number | undefined
  for (const entry of stored) {
    const parsed = parseJournalRow(entry.rowJson)
    if (parsed.ok) {
      rows.push(parsed.row)
      continue
    }
    // Reading STOPS at the first row this build cannot represent. A future
    // version latches read-only; anything else is one skipped row, disclosed.
    truncateFrom = entry.seq
    if (parsed.unreadable) {
      latched = true
    } else {
      malformedRows = 1
    }
    break
  }

  // Anchored at 1, never at the first row that HAPPENS to remain: nothing trims
  // a prefix, so a missing epoch row is a hole like any other and everything
  // behind it is unanchored. Validating from `rows[0].seq` would call the
  // leftovers contiguous and leave them out of the repair that runs before
  // provider history replaces the epoch.
  const gap = findSequenceGap(
    rows.map((row) => row.seq),
    FIRST_JOURNAL_SEQUENCE
  )
  if (gap) {
    const firstBad = rows.findIndex((row, index) => row.seq !== FIRST_JOURNAL_SEQUENCE + index)
    if (firstBad !== -1) {
      truncateFrom = rows[firstBad]?.seq ?? truncateFrom
      rows.length = firstBad
    }
  }
  // Contiguity from 1 is not the whole invariant: sequence 1 has to BE the epoch
  // row. An ordinary row there is an epoch nothing anchors, and replaying it as
  // clean is how a repaired journal silently adopts a timeline whose real
  // history was never rebuilt.
  if (rows.length > 0 && rows[0]?.kind !== 'epoch') {
    truncateFrom = rows[0]?.seq ?? truncateFrom
    rows.length = 0
  }
  for (const row of rows) {
    applyJournalRow(state, row)
  }
  state.oldestSequence = FIRST_JOURNAL_SEQUENCE

  // A latched journal reduces to nothing by design; only a writable one can be
  // held to the anchor.
  const unanchored = !latched && rows[0]?.kind !== 'epoch'
  return {
    state,
    readOnly: latched,
    corrupt:
      Boolean(gap) ||
      malformedRows > 0 ||
      unanchored ||
      (repairedFrom !== null && awaitsRebuild(rows, repairedFrom)) ||
      awaitsProviderHistory(rows),
    malformedRows,
    ...(truncateFrom !== undefined && !latched ? { truncateFrom } : {})
  }
}

/**
 * The epoch a total repair published, still holding nothing but its own anchor
 * and disclosure. The rows it dropped were never reconstructed, so provider
 * history has to be retried rather than this being called a clean timeline.
 */
function awaitsProviderHistory(rows: readonly JournalRow[]): boolean {
  const anchor = rows[0]
  if (anchor?.kind !== 'epoch' || anchor.reason !== 'unreconcilable_prefix') {
    return false
  }
  // The anchor sits at sequence 1, so content of the epoch's own starts at 2.
  return awaitsRebuild(rows, FIRST_JOURNAL_SEQUENCE + 1)
}

/**
 * True while everything at or above `contentFrom` is the repair's own
 * bookkeeping: the deleted history was never rebuilt, so the provider has to be
 * asked again. The moment the session writes content of its own past that
 * sequence the epoch IS its own history, and the retry stops rather than a
 * later import replacing rows the user has since seen.
 */
function awaitsRebuild(rows: readonly JournalRow[], contentFrom: number): boolean {
  return rows.every(
    (row) =>
      row.seq < contentFrom ||
      (row.kind === 'item' && row.itemId === JOURNAL_REPAIR_DISCLOSURE_ITEM_ID)
  )
}

/** Rows after a cursor, in sequence order. Stops at the first row this build
 *  cannot parse, exactly as replay does. */
export function readJournalRowsAfterCursor(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  afterSequence: number
): JournalRow[] {
  const rows: JournalRow[] = []
  for (const stored of readJournalRowsAfter(db, sessionId, epoch, afterSequence)) {
    const parsed = parseJournalRow(stored.rowJson)
    if (!parsed.ok) {
      break
    }
    rows.push(parsed.row)
  }
  return rows
}

/** Standalone probe. Opens its own connection and closes it before returning,
 *  so a caller holding only the returned value holds no handle. */
export function loadJournal(journalDir: string, sessionId: string): JournalLoad | null {
  const dbPath = journalDatabaseFile(journalDir)
  if (!existsSync(dbPath)) {
    return null
  }
  const opened = openJournalDatabase(dbPath)
  try {
    return replayJournal(opened.db, opened.readOnly, sessionId)
  } finally {
    opened.db.close()
  }
}

function emptyReadOnlyLoad(sessionId: string): JournalLoad {
  return {
    state: createJournalReducerState(sessionId, ''),
    readOnly: true,
    corrupt: false,
    malformedRows: 0
  }
}
