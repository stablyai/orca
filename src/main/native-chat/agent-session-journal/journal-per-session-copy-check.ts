// Checking a per-chat file's copy before it is published, and stopping one at quit.
//
// The copied rows are read back from the host's database against a second read of the file: the
// same rows, byte for byte, under the same epoch, tip and count, or the copy is refused and never
// published. The file side only hashes; the copy side also folds, with the fold a replay uses, so a
// verified copy hands back exactly the load a replay of it would return, at no second read.

import { createHash } from 'node:crypto'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { JournalHostDatabase } from './journal-host-database'
import { startJournalRowFold, type JournalLoad } from './journal-open'
import {
  JournalImportAbortedError,
  JournalImportMismatchError,
  journalOpenRefusalError
} from './journal-open-failure'
import type { ImportBatch } from './journal-per-session-source'
import { charBoundedBatches } from './journal-session-status-backfill'
import { readJournalRowsAfter } from './journal-row-table'

/** Throws once quit has stopped imports, or the caller's `signal` stopped this one: before every
 *  batch, so a stop waits at most one. */
export function assertImportNotAborted(
  database: JournalHostDatabase,
  sessionId: string,
  signal?: AbortSignal
): void {
  if (database.importsAborted || signal?.aborted) {
    throw new JournalImportAbortedError(`per-chat journal copy of ${sessionId} stopped`)
  }
}

type CopyCheckInput = {
  database: JournalHostDatabase
  sessionId: string
  epoch: string
  /** The sequence a pending repair in the file left free, as the publish will store it. */
  repairedFrom: number | null
  /** Rows per page, read again before every page. */
  batchRows: () => number
  batchChars: number
  /** Where the copy came from, for the log line. */
  legacyDirectory: string
  /** Ends each batch's task. */
  yieldTask?: () => Promise<void>
  /** Stops the verify at its next batch. */
  signal?: AbortSignal
}

/** Mismatches already logged, so a chat refused on every open logs once. */
const loggedMismatches = new Set<string>()

/** The copy's load, once its rows read back as the file's; throws a refusal otherwise. */
export async function verifyCopiedJournal(
  input: CopyCheckInput,
  expected: Iterable<ImportBatch>
): Promise<JournalLoad> {
  const want = await readCopyFacts(input, expected, null)
  // The file side's last batch and the copy side's first are tasks of their own.
  await (input.yieldTask ?? yieldToEventLoop)()
  const fold = startJournalRowFold({
    sessionId: input.sessionId,
    epoch: input.epoch,
    repairedFrom: input.repairedFrom
  })
  const got = await readCopyFacts(
    input,
    charBoundedBatches(copiedBatches(input), input.batchChars),
    fold
  )
  if (want === got) {
    return fold.finish()
  }
  const error = new JournalImportMismatchError(
    `per-chat journal of ${input.sessionId} read back as ${got} after its copy, not ${want}`
  )
  const key = `${input.sessionId}\n${want}\n${got}`
  if (!loggedMismatches.has(key)) {
    loggedMismatches.add(key)
    console.error(`[agent-session-journal] ${error.message}; ${input.legacyDirectory} is kept`)
  }
  throw journalOpenRefusalError(error)
}

/** Epoch, tip, row count and a digest of every row, a batch at a time; folds them when given one. */
async function readCopyFacts(
  input: CopyCheckInput,
  batches: Iterable<ImportBatch>,
  fold: ReturnType<typeof startJournalRowFold> | null
): Promise<string> {
  const content = createHash('sha256')
  let folding = fold !== null
  let tip = 0
  let rows = 0
  let first = true
  for (const batch of batches) {
    if (!first) {
      await (input.yieldTask ?? yieldToEventLoop)()
    }
    first = false
    assertImportNotAborted(input.database, input.sessionId, input.signal)
    rows += batch.rows.length
    for (const row of batch.rows) {
      tip = Math.max(tip, row.seq)
      // Length-framed, so no two different rows hash the same stream.
      content.update(`${row.seq}:${row.ts}:${row.rowJson.length}:`).update(row.rowJson)
      // The fold stops where a replay stops; the digest still covers every row.
      folding &&= fold?.add(row) ?? false
    }
  }
  return `${input.epoch}:${tip}:${rows}:${content.digest('hex')}`
}

function* copiedBatches(input: CopyCheckInput): Generator<ImportBatch> {
  let afterSeq = Number.MIN_SAFE_INTEGER
  for (;;) {
    const want = input.batchRows()
    const rows = readJournalRowsAfter(
      input.database.db,
      input.sessionId,
      input.epoch,
      afterSeq,
      want
    )
    const lastSeq = rows.at(-1)?.seq
    const last = rows.length < want || lastSeq === undefined
    yield { rows, last }
    if (last) {
      return
    }
    afterSeq = lastSeq
  }
}
