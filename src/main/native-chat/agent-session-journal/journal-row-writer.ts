import {
  budgetPressurePolicy,
  journalTailCanShedRows,
  journalTailIsReadyToCompact,
  type JournalCompactionPolicy
} from './journal-compaction'
import { journalBlobFileSize, putJournalBlob, removeJournalBlob } from './journal-blob-store'
import { appendJournalRows } from './journal-log-file'
import { blobDigestsInBody } from './journal-reducer'
import { journalDirectoryBytes } from './journal-physical-quota'
import type { JournalLifecycleAdmission } from './journal-lifecycle-admission'
import { journalRowByteLength, type JournalRow } from './journal-row-schema'
import {
  AgentSessionJournalError,
  assertJournalFence,
  assertJournalWritable,
  type JournalAppendBudget
} from './journal-write-guards'

type JournalBlob = { digest: string; payload: string }

export type JournalRowWriterDeps = {
  journalDir: string
  sessionId: string
  budget: JournalAppendBudget
  lifecycleAdmission: JournalLifecycleAdmission
  autoCompact: boolean
  compaction: JournalCompactionPolicy
  now: () => number
  serialize: <T>(run: () => Promise<T>) => Promise<T>
  readOnly: () => boolean
  setReadOnly: (readOnly: boolean) => void
  physicalBytes: () => number
  highestFence: () => number
  nextSequence: () => number
  tailRows: () => readonly JournalRow[]
  referencedBlobDigests: () => ReadonlySet<string>
  compact: (now: number, policy: JournalCompactionPolicy) => Promise<void>
  commit: (row: JournalRow, physicalBytes: number) => void
  appendRows?: (journalDir: string, rows: readonly JournalRow[]) => Promise<void>
}

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(
    build: (seq: number, ts: number) => JournalRow,
    blobs: readonly JournalBlob[] = []
  ): Promise<JournalRow> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const ts = this.deps.now()
      const row = build(this.deps.nextSequence(), ts)
      assertJournalFence(row.fence, this.deps.highestFence())
      // The in-memory counter is an optimization, not the quota source of
      // truth: a prior crash may have left a durable-write temp beside the
      // finals, and a concurrent/retried opener may have materialized files
      // after the last commit callback. Recount before any speculative write
      // so the peak check includes those bytes.
      let physicalBytes = Math.max(
        this.deps.physicalBytes(),
        await journalDirectoryBytes(this.deps.journalDir)
      )
      const admission = this.deps.lifecycleAdmission.prepare(row, physicalBytes)
      const newBlobs = await uniqueNewBlobs(this.deps.journalDir, blobs)
      const blobBytes = newBlobs.reduce(
        (total, blob) => total + Buffer.byteLength(blob.payload, 'utf8'),
        0
      )
      const budgetCompaction = budgetPressurePolicy(this.deps.compaction)
      let effectiveSize = physicalBytes + blobBytes + admission.protectedBytes
      if (
        this.deps.autoCompact &&
        this.deps.budget.wouldExceedSize(row, effectiveSize) &&
        journalTailCanShedRows(this.deps.tailRows(), budgetCompaction, ts)
      ) {
        await this.deps.compact(ts, budgetCompaction)
        physicalBytes = this.deps.physicalBytes()
        effectiveSize = physicalBytes + blobBytes + admission.protectedBytes
      }
      const lifecycleRateCheckpoint = admission.lifecycleCovered
        ? this.deps.budget.checkpoint()
        : null
      const appendRateCheckpoint = this.deps.budget.checkpoint()
      let committed = false
      let appendMayHaveLanded = false
      try {
        if (admission.lifecycleCovered) {
          this.deps.budget.assertReservedLifecycle(row, effectiveSize)
        } else {
          this.deps.budget.assert(row, ts, effectiveSize)
        }
        const appendedBytes = blobBytes + journalRowByteLength(row)
        if (
          physicalBytes + appendedBytes >
          this.deps.budget.maxSessionBytes - admission.protectedBytes
        ) {
          throw new AgentSessionJournalError(
            'journal_bound_exceeded',
            `agent-session journal for ${this.deps.sessionId} reached its ${this.deps.budget.maxSessionBytes}-byte physical bound`
          )
        }
        await this.commitFiles(row, newBlobs, () => {
          appendMayHaveLanded = true
        })
        physicalBytes += appendedBytes
        this.deps.commit(row, physicalBytes)
        this.deps.lifecycleAdmission.commit(admission)
        committed = true
      } catch (error) {
        if (!committed && lifecycleRateCheckpoint) {
          this.deps.budget.restore(lifecycleRateCheckpoint)
        }
        if (!committed && !appendMayHaveLanded) {
          this.deps.budget.restore(appendRateCheckpoint)
        }
        throw error
      }
      if (
        this.deps.autoCompact &&
        journalTailIsReadyToCompact(this.deps.tailRows(), this.deps.compaction, ts)
      ) {
        await this.deps.compact(ts, this.deps.compaction)
      }
      return row
    })
  }

  private async commitFiles(
    row: JournalRow,
    blobs: readonly JournalBlob[],
    markAppendLanded: () => void
  ): Promise<void> {
    const persisted: string[] = []
    let appendMayHaveLanded = false
    try {
      for (const blob of blobs) {
        await putJournalBlob(this.deps.journalDir, blob.digest, blob.payload)
        persisted.push(blob.digest)
      }
      appendMayHaveLanded = true
      markAppendLanded()
      await (this.deps.appendRows ?? appendJournalRows)(this.deps.journalDir, [row])
    } catch (error) {
      if (appendMayHaveLanded) {
        this.deps.setReadOnly(true)
        throw error
      }
      const retained = this.referencedBlobDigestsIncludingTail()
      for (const digest of persisted) {
        if (!retained.has(digest)) {
          await removeJournalBlob(this.deps.journalDir, digest)
        }
      }
      throw error
    }
  }

  private referencedBlobDigestsIncludingTail(): Set<string> {
    const retained = new Set(this.deps.referencedBlobDigests())
    for (const row of this.deps.tailRows()) {
      if (row.kind === 'item') {
        blobDigestsInBody(row.body, retained)
      } else if (row.kind === 'lifecycle-batch') {
        for (const mutation of row.mutations) {
          if (mutation.kind === 'item') {
            blobDigestsInBody(mutation.body, retained)
          }
        }
      }
    }
    return retained
  }
}

async function uniqueNewBlobs(
  journalDir: string,
  blobs: readonly JournalBlob[]
): Promise<JournalBlob[]> {
  const unique = new Map(blobs.map((blob) => [blob.digest, blob]))
  const result: JournalBlob[] = []
  for (const blob of unique.values()) {
    if ((await journalBlobFileSize(journalDir, blob.digest)) === null) {
      result.push(blob)
    }
  }
  return result
}
