import type Database from '../../sqlite/sync-database'
import { insertJournalRow } from './journal-row-table'
import type { JournalHostDatabase } from './journal-host-database'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody } from './journal-write-queue'

/** Runs between BEGIN IMMEDIATE and COMMIT, on the SAME connection as the row
 *  insert; a throw rolls the whole append back. Synchronous by construction so
 *  nothing can interleave inside the transaction. */
export type JournalRowTransactionHook = (db: Database.Database, row: JournalRow) => void

export type JournalRowWriterDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  highestFence: () => number
  nextSequence: () => number
  commit: (row: JournalRow) => void
  /** Standing hook run for EVERY appended row — the queued-draft returned
   *  transition rides here so no rejection path can bypass it. Bookkeeping: it
   *  runs in its own savepoint, so its failure is reported and never vetoes the row. */
  inTransaction?: JournalRowTransactionHook
  /** After any rollback, so a cache filled inside the transaction cannot outlive it. */
  rolledBack?: () => void
}

const BOOKKEEPING_SAVEPOINT = 'journal_row_bookkeeping'

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(
    build: (seq: number, ts: number) => JournalRow,
    hook?: JournalRowTransactionHook
  ): Promise<JournalRow> {
    return this.deps.serialize(() => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const row = build(this.deps.nextSequence(), this.deps.now())
      assertJournalFence(row.fence, this.deps.highestFence())
      try {
        // One INSERT: the chat's epoch pointer moves only when the epoch does.
        this.deps.database().transaction((db) => {
          insertJournalRow(db, this.deps.sessionId, row)
          hook?.(db, row)
          this.runBookkeeping(db, row)
        })
      } catch (error) {
        this.deps.rolledBack?.()
        throw error
      }
      // COMMIT landed, so the row is durable: adopt it before anything that can
      // fail. Rejecting here instead would leave the next append reusing a
      // sequence the table already holds.
      this.deps.commit(row)
      return row
    })
  }

  /** Assign the next sequence, make the row durable, and fold it through the SAME reducer
   *  replay uses — all inside one serialized step — answering where the row landed. */
  append(
    build: (seq: number, ts: number) => JournalRow,
    hook?: JournalRowTransactionHook
  ): Promise<AgentJournalCursor> {
    return this.enqueue(build, hook).then((row) => ({ epoch: row.epoch, sequence: row.seq }))
  }

  private runBookkeeping(db: Database.Database, row: JournalRow): void {
    const hook = this.deps.inTransaction
    if (!hook) {
      return
    }
    db.exec(`SAVEPOINT ${BOOKKEEPING_SAVEPOINT}`)
    try {
      hook(db, row)
      db.exec(`RELEASE ${BOOKKEEPING_SAVEPOINT}`)
    } catch (error) {
      db.exec(`ROLLBACK TO ${BOOKKEEPING_SAVEPOINT}`)
      db.exec(`RELEASE ${BOOKKEEPING_SAVEPOINT}`)
      this.deps.rolledBack?.()
      // The draft store re-derives what this missed from the committed rows: at open, and in
      // the drain step before a draft sends.
      console.warn('[journal-append] row bookkeeping skipped:', {
        sessionId: this.deps.sessionId,
        kind: row.kind,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
