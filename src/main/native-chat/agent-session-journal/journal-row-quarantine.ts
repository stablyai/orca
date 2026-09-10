// The rejected rows a repair is about to drop, copied out first.
//
// Replay stops at the first row this build cannot represent, and the repair then
// clears from there to the tip. Those rows are the ONLY copy of everything the
// session wrote after the fault, Orca-only submission receipts included, and no
// provider transcript can rebuild those. They are written here with their exact
// stored bytes BEFORE the delete transaction opens: a crash between the two
// leaves the rows still live plus an orphan quarantine file, never the reverse.
//
// A failed quarantine is a refusal to delete, not a reason to proceed — the
// caller latches the journal read-only and the next open retries.

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { JournalStoredRow } from './journal-row-table'

const QUARANTINE_DIR_NAME = 'quarantine'

export function journalQuarantineDirectory(journalDir: string): string {
  return join(journalDir, QUARANTINE_DIR_NAME)
}

/**
 * Copy `rows` to a durable file and return its path. Throws when the bytes are
 * not durable, so no caller can read a path here as permission to delete.
 *
 * The stored `row_json` is carried as a JSON string rather than embedded JSON:
 * a rejected row is very often not valid JSON, which is the whole reason it is
 * being quarantined.
 */
export function quarantineJournalRows(input: {
  journalDir: string
  epoch: string
  fromSeq: number
  now: number
  rows: readonly JournalStoredRow[]
}): string {
  const directory = journalQuarantineDirectory(input.journalDir)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, quarantineFileName(input.epoch, input.fromSeq, input.now))
  const lines = input.rows.map((row) =>
    JSON.stringify({ epoch: row.epoch, seq: row.seq, ts: row.ts, rowJson: row.rowJson })
  )
  const handle = openSync(file, 'w')
  try {
    writeSync(handle, Buffer.from(`${lines.join('\n')}\n`, 'utf8'))
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  return file
}

/** Epoch first so one session's repairs group together, and the rejected
 *  sequence plus the clock keep repeated repairs of one epoch distinct. */
function quarantineFileName(epoch: string, fromSeq: number, now: number): string {
  return `${epoch}-${fromSeq}-${now}.jsonl`
}
