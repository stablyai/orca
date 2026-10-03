// Writing the status row a chat already in the host's database is missing, without opening it.
//
// Version 5 creates the status table empty, so after an upgrade every chat has no row until
// something writes it. Rather than open each chat (its lease, settle and conversation), its rows are
// folded a bounded part per task, as a replay folds them, then the row is derived and written in one
// short transaction, only while the chat is still where the fold read it. Callers fold chats one at a
// time and write a slice of their rows in one transaction.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { JournalHostDatabase } from './journal-host-database'
import { startJournalRowFold, type JournalLoad } from './journal-open'
import { IMPORT_BATCH_ROWS } from './journal-per-session-source'
import { pendingJournalRepairSequence } from './journal-repair-marker'
import { readJournalRowsAfter, readJournalSessionEpoch, readJournalTip } from './journal-row-table'
import {
  deriveJournalSessionStatus,
  hasJournalSessionStatus,
  writeJournalSessionStatus,
  type JournalSessionStatus
} from './journal-session-state'

/** Row JSON per fold part, in UTF-16 units: a page of large rows is split, so each main-thread task
 *  handles about the same bytes. */
const FOLD_PART_CHARS = 256 * 1024

/** The rows split so no part holds more than `maxChars` of row JSON; a larger row is a part alone. */
function* charBoundedParts<Row extends { rowJson: string }>(
  rows: readonly Row[],
  maxChars: number
): Generator<{ rows: Row[]; last: boolean }> {
  let part: Row[] = []
  let chars = 0
  for (const row of rows) {
    if (part.length > 0 && chars + row.rowJson.length > maxChars) {
      yield { rows: part, last: false }
      part = []
      chars = 0
    }
    part.push(row)
    chars += row.rowJson.length
  }
  yield { rows: part, last: true }
}

/** A chat's status folded from its rows, and where the fold read them. */
export type FoldedJournalSessionStatus = {
  sessionId: string
  epoch: string
  tip: number
  load: JournalLoad
  status: JournalSessionStatus
}

type FoldOptions = {
  batchRows?: number
  batchChars?: number
  /** Ends each part's task: the next macrotask by default; a caller can yield only when due. */
  yieldTask?: () => Promise<void>
  /** Quit: the fold stops within one part and nothing is written. */
  signal?: AbortSignal
}

/** The epoch a fold of the chat would read, or null when it has nothing to fold: the database is a
 *  newer build's, the chat has no epoch here (it is still in a per-chat file), or it has a row. */
function foldableJournalSessionEpoch(
  database: JournalHostDatabase,
  sessionId: string
): string | null {
  if (database.readOnly) {
    return null
  }
  const epoch = readJournalSessionEpoch(database.db, sessionId)
  return epoch === null || hasJournalSessionStatus(database.db, sessionId) ? null : epoch
}

/** The chat's rows folded a part per task, as a replay folds them, and its status derived. Null when
 *  the chat already has a row, has no epoch in this database (it is still in a per-chat file), the
 *  database or the chat's rows are a newer build's, or `signal` aborted, which is checked before each
 *  part. Writes nothing. */
export async function foldJournalSessionStatus(
  database: JournalHostDatabase,
  sessionId: string,
  {
    batchRows = IMPORT_BATCH_ROWS,
    batchChars = FOLD_PART_CHARS,
    yieldTask = () => yieldToEventLoop(),
    signal
  }: FoldOptions = {}
): Promise<FoldedJournalSessionStatus | null> {
  const epoch = foldableJournalSessionEpoch(database, sessionId)
  if (epoch === null) {
    return null
  }
  const tip = readJournalTip(database.db, sessionId, epoch)
  const fold = startJournalRowFold({
    sessionId,
    epoch,
    repairedFrom: pendingJournalRepairSequence(database.db, sessionId, epoch)
  })
  for (let afterSeq = Number.MIN_SAFE_INTEGER; ;) {
    if (signal?.aborted) {
      return null
    }
    const rows = readJournalRowsAfter(database.db, sessionId, epoch, afterSeq, batchRows)
    const last = rows.at(-1)
    let folding = true
    for (const part of charBoundedParts(rows, batchChars)) {
      folding = part.rows.every(fold.add)
      // A part per task: a long chat's whole replay in one task holds up every other chat.
      if (!folding || part.last) {
        break
      }
      await yieldTask()
      if (signal?.aborted) {
        return null
      }
    }
    if (!folding || rows.length < batchRows || !last) {
      break
    }
    afterSeq = last.seq
    await yieldTask()
  }
  if (signal?.aborted) {
    return null
  }
  const load = fold.finish()
  // A newer build's rows: as an open of it does, this build writes nothing for the chat.
  if (load.readOnly) {
    return null
  }
  const status = deriveJournalSessionStatus(load.state, { settlesRosters: !load.corrupt })
  return { sessionId, epoch, tip, load, status }
}

/** Every folded chat's row in ONE transaction, each only while it still has no row and its rows are
 *  where its fold read them; a chat skipped is left to its open. */
export function writeJournalSessionStatuses(
  database: JournalHostDatabase,
  folded: readonly FoldedJournalSessionStatus[]
): void {
  if (folded.length === 0) {
    return
  }
  // Unsynced: a lost row is re-derived from the journal, and any later synced commit covers it.
  database.unsyncedTransaction((db) => {
    for (const { sessionId, epoch, tip, status } of folded) {
      if (
        hasJournalSessionStatus(db, sessionId) ||
        readJournalSessionEpoch(db, sessionId) !== epoch ||
        readJournalTip(db, sessionId, epoch) !== tip
      ) {
        continue
      }
      writeJournalSessionStatus(db, sessionId, status)
    }
  })
}
