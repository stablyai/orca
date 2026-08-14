// Durable row/blob admission for one serialized journal writer.

import {
  commitJournalBlobWritePlan,
  planJournalBlobWrites,
  readJournalBlob,
  type JournalBlobPayload
} from './journal-blob-store'
import { appendJournalRows } from './journal-log-file'
import type { JournalPayloadLimits } from './journal-payload-bounds'
import { referencedBlobDigestsForBody } from './journal-reducer'
import { journalRowByteLength, type JournalRow } from './journal-row-schema'
import { journalStorageFootprint } from './journal-storage-footprint'
import { AgentSessionJournalError, JournalAppendBudget } from './journal-write-guards'

export type { JournalBlobPayload } from './journal-blob-store'

export type JournalItemAppendOptions = {
  fence: number
  observedAt?: number
  recovered?: true
  blobs?: readonly JournalBlobPayload[]
}

type JournalAppendStorageDependencies = {
  appendRows?: typeof appendJournalRows
  measure?: typeof journalStorageFootprint
}

/** Owns the persisted-byte accounting that must precede every blob write. */
export class JournalAppendStorage {
  private persistedBytes = 0
  private poisoned = false
  private readonly budget: JournalAppendBudget

  constructor(
    private readonly sessionId: string,
    private readonly journalDir: string,
    limits: JournalPayloadLimits,
    private readonly dependencies: JournalAppendStorageDependencies = {}
  ) {
    this.budget = new JournalAppendBudget(sessionId, limits)
  }

  async open(): Promise<void> {
    await this.remeasure()
  }

  async remeasure(): Promise<void> {
    this.persistedBytes = await (this.dependencies.measure ?? journalStorageFootprint)(
      this.journalDir
    )
  }

  get isPoisoned(): boolean {
    return this.poisoned
  }

  /** A failed post-mutation measurement leaves the physical quota unknown.
   *  This instance must never admit another mutation after that point. */
  assertWritable(): void {
    if (this.poisoned) {
      throw new AgentSessionJournalError(
        'journal_read_only',
        `agent-session journal for ${this.sessionId} could not verify its durable footprint; this host is read-only`
      )
    }
  }

  async remeasureAfterMutation(): Promise<void> {
    try {
      await this.remeasure()
    } catch (error) {
      this.poisoned = true
      throw error
    }
  }

  async append(
    row: JournalRow,
    admissionTs: number,
    blobs: readonly JournalBlobPayload[] = []
  ): Promise<void> {
    this.assertWritable()
    await assertBlobReferences(row, blobs, this.journalDir)
    const blobPlan = await planJournalBlobWrites(this.journalDir, blobs)
    this.budget.assert(row, admissionTs, this.persistedBytes, blobPlan.additionalBytes)
    let addedBlobBytes = 0
    try {
      addedBlobBytes = await commitJournalBlobWritePlan(this.journalDir, blobPlan)
      await (this.dependencies.appendRows ?? appendJournalRows)(this.journalDir, [row])
    } catch (error) {
      // Once a durable blob or row write was attempted, its outcome can be
      // ambiguous (for example append succeeded but fsync failed). Continuing
      // from the old in-memory sequence could fork the journal.
      this.poisoned = true
      try {
        await this.remeasureAfterMutation()
      } catch (remeasureError) {
        throw new AggregateError(
          [error, remeasureError],
          `agent-session journal for ${this.sessionId} failed a write and could not verify its durable footprint`
        )
      }
      throw error
    }
    this.persistedBytes += addedBlobBytes + journalRowByteLength(row)
  }
}

async function assertBlobReferences(
  row: JournalRow,
  blobs: readonly JournalBlobPayload[],
  journalDir: string
): Promise<void> {
  const expected = row.kind === 'item' ? referencedBlobDigestsForBody(row.body) : new Set<string>()
  const provided = new Set(blobs.map((blob) => blob.digest))
  for (const digest of provided) {
    if (!expected.has(digest)) {
      throw new Error(`journal blob ${digest} is not referenced by its row`)
    }
  }
  for (const digest of expected) {
    if (!provided.has(digest) && (await readJournalBlob(journalDir, digest)) === null) {
      throw new Error(`journal row references missing blob ${digest}`)
    }
  }
}
