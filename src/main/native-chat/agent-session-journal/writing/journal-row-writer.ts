import type { JournalReducerState } from '../projection/journal-reducer'
import { insertJournalRow } from '../durable-rows/journal-row-table'
import type { JournalTransactionalDatabase } from '../database/journal-host-database'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody } from '../journal-store-contracts'
import type Database from '../../../sqlite/sync-database'
import type { JournalWriterEffect, JournalWriterEffectResult } from '../journal-writer-effects'

/** Write receipts in the row transaction; notify synchronously after COMMIT, never rollback. */
export type JournalOperationReceipt = {
  fold?: (draft: JournalReducerState) => void
  write?: (db: Database.Database, row?: JournalRow) => void
  committed?: () => void
  /** The worker writer's form of `write`/`committed`; absent where the receipt is writer-local. */
  stage?: (context: JournalReceiptStage) => Promise<JournalStagedReceipt>
}

/** One writer command's staging; receipts co-written in it build on each other. */
export type JournalReceiptStage = { savedAt: number; row?: JournalRow['kind'] }

/** Effects ride in the command's row transaction; settle runs once after the acknowledged
 *  COMMIT with this receipt's results, or with undefined after a rollback or an unwritten receipt. */
export type JournalStagedReceipt = {
  effects: readonly JournalWriterEffect[]
  /** Resolve every co-staged store draft before any committed callback runs. */
  adopt?: (results: readonly JournalWriterEffectResult[] | undefined) => void
  settle: (results: readonly JournalWriterEffectResult[] | undefined) => void
}

export type JournalReceiptPreparation =
  | JournalOperationReceipt
  | ((rows: readonly JournalRow[]) => JournalOperationReceipt | undefined)

export function composeJournalOperationReceipts(
  ...receipts: JournalOperationReceipt[]
): JournalOperationReceipt {
  const stages = receipts.flatMap((receipt) => (receipt.stage ? [receipt.stage] : []))
  return {
    fold: (draft) => receipts.forEach((receipt) => receipt.fold?.(draft)),
    write: (db, row) => receipts.forEach((receipt) => receipt.write?.(db, row)),
    committed: () => receipts.forEach((receipt) => receipt.committed?.()),
    ...(stages.length === receipts.length
      ? { stage: (context) => stageJournalOperationReceipts(stages, context) }
      : {})
  }
}

/** Stage in order so later receipts build on earlier drafts; a failed stage releases the earlier ones. */
async function stageJournalOperationReceipts(
  stages: readonly NonNullable<JournalOperationReceipt['stage']>[],
  context: JournalReceiptStage
): Promise<JournalStagedReceipt> {
  const staged: JournalStagedReceipt[] = []
  try {
    for (const stage of stages) {
      staged.push(await stage(context))
    }
  } catch (error) {
    staged.forEach((entry) => entry.settle(undefined))
    throw error
  }
  const adopt: NonNullable<JournalStagedReceipt['adopt']> = (results) => {
    let offset = 0
    for (const entry of staged) {
      const count = entry.effects.length
      entry.adopt?.(results?.slice(offset, offset + count))
      offset += count
    }
  }
  return {
    effects: staged.flatMap((entry) => entry.effects),
    adopt,
    settle: (results) => {
      let failure: unknown
      let adoptionFailed = false
      try {
        adopt(results)
      } catch (error) {
        failure = error
        adoptionFailed = true
      }
      let offset = 0
      for (const entry of staged) {
        const count = entry.effects.length
        try {
          entry.settle(adoptionFailed ? undefined : results?.slice(offset, offset + count))
        } catch (error) {
          failure ??= error
        }
        offset += count
      }
      if (failure !== undefined) {
        throw failure
      }
    }
  }
}

/** Preserve staged receipt adoption when a host action observes its acknowledgement. */
export function onJournalReceiptCommitted(
  receipt: JournalOperationReceipt,
  committed: () => void
): JournalOperationReceipt {
  const stage = receipt.stage
  return {
    ...receipt,
    ...(receipt.committed
      ? {
          committed: () => {
            receipt.committed?.()
            committed()
          }
        }
      : {}),
    ...(stage
      ? {
          stage: async (context) => {
            const staged = await stage(context)
            return {
              effects: staged.effects,
              adopt: staged.adopt,
              settle: (results) => {
                staged.settle(results)
                if (results !== undefined) {
                  committed()
                }
              }
            }
          }
        }
      : {})
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
      receipt.write?.(db)
    }
    return result
  }
}

export type JournalRowWriterDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
  database: () => JournalTransactionalDatabase
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
          if (!this.deps.prepare) {
            insertJournalRow(db, this.deps.sessionId, row, savedAt)
          }
          const adopt = this.deps.prepare?.(db, [row], savedAt, receipt?.fold)
          receipt?.write?.(db, this.project([row])[0])
          return adopt
        },
        (adopt) => adopt?.()
      )
      receipt?.committed?.()
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
        if (!this.deps.prepare) {
          for (const row of rows) {
            insertJournalRow(db, this.deps.sessionId, row, ts)
          }
        }
        const adopt = this.deps.prepare?.(db, rows, ts, receipt?.fold)
        receipt?.write?.(db, receiptRow?.(this.project(rows)))
        return adopt
      },
      (adopt) => adopt?.()
    )
    receipt?.committed?.()
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
