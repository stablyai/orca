import { settleJournalCommit } from './journal-committed-effects'
import type { JournalPersistencePlan } from './journal-persistence-plan'
import { journalRowReadBack } from './journal-row-table'
import type { JournalHostDatabase } from './journal-host-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalRow } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody } from './journal-write-queue'
import type { JournalReducerState } from './journal-reducer'

/** Write receipts in the row transaction; notify synchronously after COMMIT, never rollback. */
export type JournalOperationReceipt = {
  fold?: (draft: JournalReducerState) => void
  write: (plan: JournalPersistencePlan, row?: JournalRow) => void | Promise<void>
  committed: () => void
}

export type JournalReceiptPreparation =
  | JournalOperationReceipt
  | ((rows: readonly JournalRow[]) => JournalOperationReceipt | undefined)

export function composeJournalOperationReceipts(
  ...receipts: JournalOperationReceipt[]
): JournalOperationReceipt {
  return {
    fold: (draft) => receipts.forEach((receipt) => receipt.fold?.(draft)),
    write: async (plan, row) => {
      for (const receipt of receipts) {
        await receipt.write(plan, row)
      }
    },
    committed: () => settleJournalCommit(...receipts.map((receipt) => receipt.committed))
  }
}

export function writeReceiptIfChanged<T>(
  run: (plan: JournalPersistencePlan) => T | Promise<T>,
  changed: (result: T) => boolean,
  receipt?: JournalOperationReceipt
): (plan: JournalPersistencePlan) => Promise<T> {
  return async (db) => {
    const result = await run(db)
    if (receipt && changed(result)) {
      await receipt.write(db)
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
    plan: JournalPersistencePlan,
    rows: readonly JournalRow[],
    savedAt: number,
    finishFold?: (draft: JournalReducerState) => void
  ) => Promise<() => void>
  commit: (rows: readonly JournalRow[], savedAt: number, inputChanged?: boolean) => void
  verify?: () => Promise<void>
  /** Identifies coalescible text; accepted batches still commit with FULL durability. */
  streamedTextRevision?: (row: JournalRow) => boolean
  outputRevision?: (row: JournalRow) => boolean
}

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(
    build: (seq: number, ts: number) => JournalRow,
    prepareReceipt?: JournalReceiptPreparation
  ): Promise<JournalRow> {
    return this.deps.serialize(async () => {
      const [row] = await this.writeRows(
        () => [build],
        prepareReceipt,
        (rows) => rows[0]
      )
      return row
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
  async writeRows(
    plan: () => readonly ((seq: number, ts: number) => JournalRow)[],
    prepareReceipt?: JournalReceiptPreparation,
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  ): Promise<JournalRow[]> {
    let streamed = false
    const result = await this.deps.database().transaction(
      async (db) => {
        assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
        const first = this.deps.nextSequence()
        const savedAt = this.deps.now()
        const rows = plan().map((build, index) => build(first + index, savedAt))
        if (rows.length === 0) {
          return { rows, savedAt, receipt: undefined, adopt: undefined, inputChanged: false }
        }
        for (const row of rows) {
          assertJournalFence(row.fence, this.deps.highestFence())
        }
        const receipt = typeof prepareReceipt === 'function' ? prepareReceipt(rows) : prepareReceipt
        streamed = !receipt && rows.length > 0 && this.streamed(rows)
        const inputChanged = Boolean(receipt) || !this.outputOnly(rows)
        if (!this.deps.prepare) {
          for (const row of rows) {
            this.stageRow(db, row, savedAt)
          }
        }
        const adopt = rows.length
          ? await this.deps.prepare?.(db, rows, savedAt, receipt?.fold)
          : undefined
        await receipt?.write(db, receiptRow?.(this.project(rows)))
        return { rows, savedAt, receipt, adopt, inputChanged }
      },
      () => streamed,
      ({ rows, savedAt, receipt, adopt, inputChanged }) => {
        settleJournalCommit(
          () => adopt?.(),
          () => receipt?.committed(),
          () => {
            if (rows.length) {
              this.deps.commit(rows, savedAt, inputChanged)
            }
          }
        )
      }
    )
    if (result.rows.length) {
      await this.deps.verify?.()
    }
    return this.project(result.rows)
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

  private project(rows: readonly JournalRow[]): JournalRow[] {
    return this.deps.project?.(rows) ?? [...rows]
  }

  private outputOnly(rows: readonly JournalRow[]): boolean {
    return this.deps.outputRevision !== undefined && rows.every(this.deps.outputRevision)
  }

  private stageRow(plan: JournalPersistencePlan, row: JournalRow, savedAt: number): void {
    plan.add({
      kind: 'rows',
      sessionId: this.deps.sessionId,
      rows: [
        {
          epoch: row.epoch,
          seq: row.seq,
          savedAt,
          json: journalRowReadBack(this.deps.sessionId, row).rowJson
        }
      ]
    })
  }

  private streamed(rows: readonly JournalRow[]): boolean {
    const { streamedTextRevision } = this.deps
    return streamedTextRevision !== undefined && rows.every((row) => streamedTextRevision(row))
  }
}
