// Dropping the rejected suffix a replay found — after it is durable elsewhere.
//
// Ordering is the whole contract: quarantine, fsync, THEN the transaction that
// deletes the rows and records the rebuild they are owed. A repair that cannot
// write the copy does not delete; it reports `quarantined: false` and the caller
// latches read-only, which leaves the timeline exactly as it was found.

import type Database from '../../sqlite/sync-database'
import { quarantineJournalRows } from './journal-row-quarantine'
import { writeJournalRepairMarker } from './journal-repair-marker'
import { deleteJournalRowSuffix, readJournalRowsAfter } from './journal-row-table'

export type JournalRepairedSuffix =
  | { quarantined: true; quarantineFile: string; deleted: number }
  /** The rows are still live and untouched. */
  | { quarantined: false; error: unknown }

export function quarantineAndDeleteJournalRepairedSuffix(input: {
  db: Database.Database
  journalDir: string
  sessionId: string
  epoch: string
  /** First sequence of the rejected suffix. */
  fromSeq: number
  /** First sequence left free once the suffix is gone. */
  contentFrom: number
  now: number
}): JournalRepairedSuffix {
  let quarantineFile: string
  try {
    quarantineFile = quarantineJournalRows({
      journalDir: input.journalDir,
      epoch: input.epoch,
      fromSeq: input.fromSeq,
      now: input.now,
      // `> fromSeq - 1` is `>= fromSeq`: the rejected row itself and everything
      // behind it, which is exactly what the delete below removes.
      rows: readJournalRowsAfter(input.db, input.sessionId, input.epoch, input.fromSeq - 1)
    })
  } catch (error) {
    return { quarantined: false, error }
  }
  input.db.exec('BEGIN IMMEDIATE')
  try {
    const deleted = deleteJournalRowSuffix(input.db, input.sessionId, input.epoch, input.fromSeq)
    writeJournalRepairMarker(input.db, input.sessionId, input.epoch, input.contentFrom, input.now)
    input.db.exec('COMMIT')
    return { quarantined: true, quarantineFile, deleted }
  } catch (error) {
    input.db.exec('ROLLBACK')
    throw error
  }
}
