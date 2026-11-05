import { yieldJournalHost, finishJournalStepsAsync } from './journal-reconstruction-steps'
import type { JournalPersistencePlan } from './journal-persistence-plan'
import { journalRowReadBack } from './journal-row-table'
import type { JournalHostDatabase } from './journal-host-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalRow } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody } from './journal-write-queue'
import type { JournalReducerState } from './journal-reducer'

export type JournalFinishFold = (draft: JournalReducerState) => void | Generator<void>
type JournalRowBuilders = Iterable<void | ((seq: number, ts: number) => JournalRow)>
type JournalRowPlan = () => JournalRowBuilders | Promise<JournalRowBuilders>

/** Write receipts in the row transaction; settle in order after COMMIT, never rollback. */
export type JournalOperationReceipt = {
  replacement?: true
  fold?: JournalFinishFold
  write: (plan: JournalPersistencePlan, row?: JournalRow) => void | Promise<void>
  committed: () => void | Promise<void>
}

export type JournalReceiptPreparation =
  | JournalOperationReceipt
  | ((
      rows: readonly JournalRow[]
    ) => JournalOperationReceipt | undefined | Promise<JournalOperationReceipt | undefined>)

export function composeJournalOperationReceipts(
  ...receipts: JournalOperationReceipt[]
): JournalOperationReceipt {
  return {
    ...(receipts.some((receipt) => receipt.replacement) ? { replacement: true } : {}),
    fold: function* (draft) {
      for (const receipt of receipts) {
        const steps = receipt.fold?.(draft)
        if (steps) {
          yield* steps
        }
      }
    },
    write: async (plan, row) => {
      for (const receipt of receipts) {
        await receipt.write(plan, row)
      }
    },
    committed: () => settleJournalCommitAsync(receipts.map((receipt) => receipt.committed))
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

export type JournalCommitObserver = (
  rows?: readonly JournalRow[],
  inputChanged?: boolean,
  replacement?: boolean
) => void | Promise<void>

export type JournalRowWriterDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  highestFence: () => number
  nextSequence: () => number
  prepare?: (
    plan: JournalPersistencePlan,
    rows: readonly JournalRow[],
    savedAt: number,
    finishFold?: JournalFinishFold,
    replacement?: boolean
  ) => Promise<() => void | Promise<void>>
  project?: (rows: readonly JournalRow[]) => JournalRow[]
  projectSteps?: (rows: readonly JournalRow[]) => Generator<void, JournalRow[]>
  commit: (
    rows: readonly JournalRow[],
    savedAt: number,
    inputChanged?: boolean,
    replacement?: boolean
  ) => unknown
  preparePublication?: (state: JournalReducerState) => Promise<unknown>
  verify?: () => Promise<void>
  /** Streamed-text-only revisions may skip per-commit fsync; settlement makes them durable. */
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
    plan: JournalRowPlan,
    receipt?: JournalReceiptPreparation,
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  ): Promise<JournalRow[]> {
    return this.deps.serialize(() => this.writeRows(plan, receipt, receiptRow))
  }

  /** Caller must already own the write lane. */
  async writeRows(
    plan: JournalRowPlan,
    prepareReceipt?: JournalReceiptPreparation,
    receiptRow?: (rows: readonly JournalRow[]) => JournalRow | undefined
  ): Promise<JournalRow[]> {
    let streamed = false
    const result = await this.deps.database().transaction(
      async (db) => {
        assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
        const first = this.deps.nextSequence()
        const savedAt = this.deps.now()
        const rows = await finishJournalStepsAsync(this.buildRows(await plan(), first, savedAt))
        if (rows.length === 0) {
          return { rows, projected: rows, savedAt, receipt: undefined, adopt: undefined }
        }
        const receipt =
          typeof prepareReceipt === 'function' ? await prepareReceipt(rows) : prepareReceipt
        streamed = !receipt && rows.length > 0 && this.streamed(rows)
        if (!this.deps.prepare) {
          await finishJournalStepsAsync(this.stageRows(db, rows, savedAt))
        }
        const adopt = rows.length
          ? await this.deps.prepare?.(db, rows, savedAt, receipt?.fold, receipt?.replacement)
          : undefined
        if (receipt?.replacement && db.preparedState) {
          await this.deps.preparePublication?.(db.preparedState)
        }
        const projected = await this.projectAsync(rows)
        await receipt?.write(db, receiptRow?.(projected))
        return { rows, projected, savedAt, receipt, adopt }
      },
      () => streamed,
      ({ rows, savedAt, receipt, adopt }) => {
        return settleJournalCommitAsync([
          () => adopt?.(),
          () => receipt?.committed(),
          (): void | Promise<void> => {
            if (rows.length) {
              const pending = this.deps.commit(
                rows,
                savedAt,
                Boolean(receipt) || !this.outputOnly(rows),
                receipt?.replacement
              )
              return pending instanceof Promise ? pending.then(() => {}) : undefined
            }
          }
        ])
      }
    )
    if (result.rows.length) {
      await this.deps.verify?.()
    }
    return result.projected
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

  private *buildRows(
    builders: JournalRowBuilders,
    first: number,
    savedAt: number
  ): Generator<void, JournalRow[]> {
    const rows: JournalRow[] = []
    for (const build of builders) {
      if (build) {
        const row = build(first + rows.length, savedAt)
        assertJournalFence(row.fence, this.deps.highestFence())
        rows.push(row)
      }
      yield
    }
    return rows
  }

  private *stageRows(
    plan: JournalPersistencePlan,
    rows: readonly JournalRow[],
    savedAt: number
  ): Generator<void> {
    for (const row of rows) {
      this.stageRow(plan, row, savedAt)
      yield
    }
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

  private async projectAsync(rows: readonly JournalRow[]): Promise<JournalRow[]> {
    if (this.deps.projectSteps) {
      return finishJournalStepsAsync(this.deps.projectSteps(rows))
    }
    return (
      this.deps.project?.(rows) ??
      finishJournalStepsAsync(
        (function* () {
          const result: JournalRow[] = []
          for (const row of rows) {
            result.push(row)
            yield
          }
          return result
        })()
      )
    )
  }
  private outputOnly(rows: readonly JournalRow[]): boolean {
    return this.deps.outputRevision !== undefined && rows.every(this.deps.outputRevision)
  }

  private streamed(rows: readonly JournalRow[]): boolean {
    const { streamedTextRevision } = this.deps
    return streamedTextRevision !== undefined && rows.every((row) => streamedTextRevision(row))
  }
}

/** Complete all mandatory known-committed effects before surfacing any failure. */
export function settleJournalCommit(...effects: (() => void)[]): void {
  const failures: unknown[] = []
  for (const effect of effects) {
    try {
      effect()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length) {
    throw new AggregateError(failures, 'journal committed effects failed')
  }
}

/** Epoch-sized committed effects retain ownership and ordering across finite host turns. */
export async function settleJournalCommitAsync(
  effects: Iterable<() => void | Promise<void>>
): Promise<void> {
  const failures: unknown[] = []
  let work = 0
  for (const effect of effects) {
    try {
      const pending = effect()
      if (pending) {
        await pending
      }
    } catch (error) {
      failures.push(error)
    }
    if (++work === 128) {
      work = 0
      await yieldJournalHost()
    }
  }
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length) {
    throw new AggregateError(failures, 'journal committed effects failed')
  }
}
