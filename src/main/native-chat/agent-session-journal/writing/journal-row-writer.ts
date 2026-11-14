import type { JournalReducerState } from '../projection/journal-reducer'
import { insertJournalRow } from '../durable-rows/journal-row-table'
import type { JournalHostDatabase } from '../database/journal-host-database'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalRow, JournalSubmissionRow } from '../durable-rows/journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody } from './journal-write-queue'
import type Database from '../../../sqlite/sync-database'

/** Write receipts in the row transaction; notify synchronously after COMMIT, never rollback. */
export type JournalOperationReceipt = {
  validate?: (db: Database.Database) => void
  fold?: (draft: JournalReducerState) => void
  write: (db: Database.Database, row?: JournalRow, submission?: JournalSubmissionRow) => void
  committed: () => void
}

export type JournalReceiptPreparation =
  | JournalOperationReceipt
  | ((rows: readonly JournalRow[]) => JournalOperationReceipt | undefined)

export function composeJournalOperationReceipts(
  ...receipts: JournalOperationReceipt[]
): JournalOperationReceipt {
  return {
    validate: (db) => receipts.forEach((receipt) => receipt.validate?.(db)),
    fold: (draft) => receipts.forEach((receipt) => receipt.fold?.(draft)),
    write: (db, row, submission) =>
      receipts.forEach((receipt) => receipt.write(db, row, submission)),
    committed: () => receipts.forEach((receipt) => receipt.committed())
  }
}

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
  project?: (rows: readonly JournalRow[]) => JournalRow[]
  prepare?: (
    db: Database.Database,
    rows: readonly JournalRow[],
    savedAt: number,
    finishFold?: (draft: JournalReducerState) => void
  ) => () => void
  commit: (rows: readonly JournalRow[], savedAt: number, inputChanged?: boolean) => void
  outputRevision?: (row: JournalRow) => boolean
}

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(
    build: (seq: number, ts: number) => JournalRow,
    prepareReceipt?: JournalReceiptPreparation
  ): Promise<JournalRow> {
    return this.deps.serialize(() => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const savedAt = this.deps.now()
      const row = build(this.deps.nextSequence(), savedAt)
      assertJournalFence(row.fence, this.deps.highestFence())
      const receipt = typeof prepareReceipt === 'function' ? prepareReceipt([row]) : prepareReceipt
      const inputChanged = Boolean(receipt) || !this.outputOnly([row])
      this.deps.database().transaction(
        (db) => {
          receipt?.validate?.(db)
          if (!this.deps.prepare) {
            insertJournalRow(db, this.deps.sessionId, row, savedAt)
          }
          const adopt = this.deps.prepare?.(db, [row], savedAt, receipt?.fold)
          receipt?.write(db, this.project([row])[0])
          return adopt
        },
        (adopt) => adopt?.()
      )
      receipt?.committed()
      this.deps.commit([row], savedAt, inputChanged)
      return this.project([row])[0]!
    })
  }

  /** Plan on the write lane and commit all rows atomically; receiptRow identifies the receipt target. */
  enqueueRows(
    plan: () => readonly ((seq: number, ts: number) => JournalRow)[],
    receipt?: JournalReceiptPreparation,
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  ): Promise<JournalRow[]> {
    return this.deps.serialize(() => this.writeRows(plan, receipt, receiptRow))
  }

  /** Caller must already own the write lane. */
  writeRows(
    plan: () => readonly ((seq: number, ts: number) => JournalRow)[],
    prepareReceipt?: JournalReceiptPreparation,
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
    const receipt = typeof prepareReceipt === 'function' ? prepareReceipt(rows) : prepareReceipt
    const inputChanged = Boolean(receipt) || !this.outputOnly(rows)
    this.deps.database().transaction(
      (db) => {
        receipt?.validate?.(db)
        if (!this.deps.prepare) {
          for (const row of rows) {
            insertJournalRow(db, this.deps.sessionId, row, ts)
          }
        }
        const adopt = this.deps.prepare?.(db, rows, ts, receipt?.fold)
        receipt?.write(db, receiptRow?.(this.project(rows)))
        return adopt
      },
      (adopt) => adopt?.()
    )
    receipt?.committed()
    this.deps.commit(rows, ts, inputChanged)
    return this.project(rows)
  }

  private project(rows: readonly JournalRow[]): JournalRow[] {
    return this.deps.project?.(rows) ?? [...rows]
  }

  /** Serialize sequence assignment, durable write and replay-equivalent folding. */
  append(
    build: (seq: number, ts: number) => JournalRow,
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    return this.enqueue(build, receipt).then((row) => ({
      epoch: row.epoch,
      sequence: row.seq
    }))
  }

  private outputOnly(rows: readonly JournalRow[]): boolean {
    return this.deps.outputRevision !== undefined && rows.every(this.deps.outputRevision)
  }
}
