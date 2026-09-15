// Loading a journal: the session projection names the live epoch, and that
// epoch's rows are folded through the reducer in sequence order.
//
// There is no snapshot to anchor to and no superseded-epoch rows to drop — a
// roll deletes them in the same transaction that publishes the new epoch. A gap
// in the surviving sequence is corruption, and the caller rolls the epoch
// rather than rendering a partial timeline.

import { existsSync } from 'node:fs'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'
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
  const repairedFrom = pendingJournalRepairSequence(db, sessionId, epoch)
  let expectedSequence = FIRST_JOURNAL_SEQUENCE
  let gapSequence: number | undefined
  let unanchoredSequence: number | undefined
  let anchor: Extract<JournalRow, { kind: 'epoch' }> | undefined
  let repairHasContent = false
  let providerHasContent = false
  let malformedRows = 0
  let latched = false
  let truncateFrom: number | undefined

  for (const entry of iterateJournalEpochRows(db, sessionId, epoch)) {
    const parsed = parseJournalRow(entry.rowJson)
    if (!parsed.ok) {
      truncateFrom = entry.seq
      latched = parsed.unreadable
      malformedRows = parsed.unreadable ? 0 : 1
      break
    }
    const row = parsed.row
    // Parse past a gap so an unreadable future row still latches read-only.
    if (gapSequence !== undefined) {
      continue
    }
    if (row.seq !== expectedSequence) {
      gapSequence = row.seq
      continue
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
      continue
    }
    applyJournalRow(state, row)
    const disclosure = row.kind === 'item' && row.itemId === JOURNAL_REPAIR_DISCLOSURE_ITEM_ID
    if (!disclosure) {
      repairHasContent ||= repairedFrom !== null && row.seq >= repairedFrom
      providerHasContent ||= row.seq >= FIRST_JOURNAL_SEQUENCE + 1
    }
  }
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
