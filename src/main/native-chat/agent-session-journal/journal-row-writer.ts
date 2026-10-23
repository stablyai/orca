import type Database from '../../sqlite/sync-database'
import { insertJournalRow } from './journal-row-table'
import type { JournalHostDatabase } from './journal-host-database'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody } from './journal-write-queue'

/** An operation's receipt, committed with the journal write that makes it true: `write` runs
 *  inside that transaction on the same connection, `committed` synchronously right after its
 *  COMMIT and never after a rollback. */
export type JournalOperationReceipt = {
  write: (db: Database.Database, row?: JournalRow) => void
  committed: () => void
}

export function composeJournalOperationReceipts(
  ...receipts: JournalOperationReceipt[]
): JournalOperationReceipt {
  return {
    write: (db, row) => receipts.forEach((receipt) => receipt.write(db, row)),
    committed: () => receipts.forEach((receipt) => receipt.committed())
  }
}

/** `run`, with `receipt` written in its transaction only when `changed` says it wrote something. */
export function writeReceiptIfChanged<T>(
  run: (db: Database.Database) => T,
  changed: (result: T) => boolean,
  receipt?: JournalOperationReceipt
): (db: Database.Database) => T {
  return (db) => {
    const result = run(db)
    if (receipt && changed(result)) {
      receipt.write(db)
    }
    return result
  }
}

export type JournalRowWriterDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  highestFence: () => number
  nextSequence: () => number
  commit: (rows: readonly JournalRow[], savedAt: number) => void
  /** Rows an OS crash may lose without losing anything but streamed text; they commit without
   *  the per-commit fsync (`isJournalStreamedTextRevision`). */
  streamedTextRevision?: (row: JournalRow) => boolean
}

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(
    build: (seq: number, ts: number) => JournalRow,
    receipt?: JournalOperationReceipt
  ): Promise<JournalRow> {
    return this.deps.serialize(() => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const savedAt = this.deps.now()
      const row = build(this.deps.nextSequence(), savedAt)
      assertJournalFence(row.fence, this.deps.highestFence())
      // One INSERT: the chat's epoch pointer moves only when the epoch does.
      this.deps.database().transaction(
        (db) => {
          insertJournalRow(db, this.deps.sessionId, row, savedAt)
          receipt?.write(db, row)
        },
        !receipt && this.streamed([row])
      )
      // COMMIT landed, so the row is durable: adopt it before anything that can
      // fail. Rejecting here instead would leave the next append reusing a
      // sequence the table already holds. The ledger first: it cannot throw, the fold can.
      receipt?.committed()
      this.deps.commit([row], savedAt)
      return row
    })
  }

  /** Several rows in ONE transaction, in order, planned once the lane is this append's: none is
   *  durable unless all are, so no reader ever meets some without the rest. `receiptRow` picks the
   *  row `receipt` names. */
  enqueueRows(
    plan: () => readonly ((seq: number, ts: number) => JournalRow)[],
    receipt?: JournalOperationReceipt,
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  ): Promise<JournalRow[]> {
    return this.deps.serialize(() => this.writeRows(plan, receipt, receiptRow))
  }

  /** `enqueueRows`' write, for a caller already running at its own turn in the queue. */
  writeRows(
    plan: () => readonly ((seq: number, ts: number) => JournalRow)[],
    receipt?: JournalOperationReceipt,
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  ): JournalRow[] {
    assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
    const first = this.deps.nextSequence()
    const ts = this.deps.now()
    const rows = plan().map((build, index) => build(first + index, ts))
    if (rows.length === 0) {
      return rows
    }
    for (const row of rows) {
      assertJournalFence(row.fence, this.deps.highestFence())
    }
    this.deps.database().transaction(
      (db) => {
        for (const row of rows) {
          insertJournalRow(db, this.deps.sessionId, row, ts)
        }
        receipt?.write(db, receiptRow?.(rows))
      },
      !receipt && this.streamed(rows)
    )
    receipt?.committed()
    this.deps.commit(rows, ts)
    return rows
  }

  /** Assign the next sequence, make the row durable, and fold it through the SAME reducer
   *  replay uses — all inside one serialized step — answering where the row landed. */
  append(
    build: (seq: number, ts: number) => JournalRow,
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    return this.enqueue(build, receipt).then((row) => ({
      epoch: row.epoch,
      sequence: row.seq
    }))
  }

  private streamed(rows: readonly JournalRow[]): boolean {
    const { streamedTextRevision } = this.deps
    return streamedTextRevision !== undefined && rows.every((row) => streamedTextRevision(row))
  }
}
