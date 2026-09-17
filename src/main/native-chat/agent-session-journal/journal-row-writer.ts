import type Database from '../../sqlite/sync-database'
import { insertJournalRow, upsertJournalSessionRow } from './journal-row-table'
import type { JournalRow } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'

export type JournalRowWriterDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: () => Promise<T>) => Promise<T>
  database: () => { db: Database.Database }
  readOnly: () => boolean
  highestFence: () => number
  nextSequence: () => number
  commit: (row: JournalRow) => void
}

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(build: (seq: number, ts: number) => JournalRow): Promise<JournalRow> {
    return this.enqueueMany((seq, ts) => [build(seq, ts)]).then((rows) => {
      const row = rows[0]
      if (!row) {
        throw new Error('journal_row_writer_returned_no_row')
      }
      return row
    })
  }

  /** Persists existing row shapes under one commit, then folds them in sequence order. */
  enqueueMany(build: (seq: number, ts: number) => readonly JournalRow[]): Promise<JournalRow[]> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const firstSequence = this.deps.nextSequence()
      const rows = [...build(firstSequence, this.deps.now())]
      if (rows.length === 0) {
        throw new Error('journal_row_writer_returned_no_rows')
      }
      const firstRowSequence = rows[0]?.seq
      if (firstRowSequence === undefined) {
        throw new Error('journal_row_writer_returned_no_rows')
      }
      for (const [index, row] of rows.entries()) {
        if (row.seq !== firstRowSequence + index) {
          throw new Error('journal_row_writer_noncontiguous_sequence')
        }
        assertJournalFence(row.fence, this.deps.highestFence())
      }
      const { db } = this.deps.database()
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const row of rows) {
          insertJournalRow(db, this.deps.sessionId, row)
        }
        const last = rows.at(-1)
        if (!last) {
          throw new Error('journal_row_writer_returned_no_rows')
        }
        upsertJournalSessionRow(db, this.deps.sessionId, last.epoch, last.ts)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      // COMMIT landed, so the rows are durable: adopt them before anything that can
      // fail. Rejecting here instead would leave the next append reusing a
      // sequence the table already holds.
      for (const row of rows) {
        this.deps.commit(row)
      }
      return rows
    })
  }
}
