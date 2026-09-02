import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { copyFileDurable } from '../../durable-file-write'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { compactJournal, type JournalCompactionPolicy } from './journal-compaction'
import { JOURNAL_LOG_FILE, JOURNAL_SNAPSHOT_FILE, appendJournalRows } from './journal-log-file'
import {
  applyJournalRow,
  blobDigestsInBody,
  createJournalReducerState,
  referencedBlobDigests,
  type JournalReducerState
} from './journal-reducer'
import { buildJournalItemRow, journalRowBase } from './journal-row-builders'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { journalRowByteLength } from './journal-row-schema'
import { assertJournalFence, type JournalAppendBudget } from './journal-write-guards'
import type { JournalLoad } from './journal-open'
import { assertJournalPhysicalCapacity, journalDirectoryBytes } from './journal-physical-quota'
import {
  JOURNAL_BLOB_DIR,
  journalBlobFileSize,
  putJournalBlob,
  pruneJournalBlobs,
  removeJournalBlob
} from './journal-blob-store'

export type JournalReplacementItem = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  blobs?: readonly { digest: string; payload: string }[]
  observedAt?: number
}

export async function replaceJournalEpoch(input: {
  journalDir: string
  identity: AgentSessionJournalIdentity
  reason: AgentJournalEpochReason
  fence: number
  items: readonly JournalReplacementItem[]
  budget: JournalAppendBudget
  compaction: JournalCompactionPolicy
  now: () => number
  mintEpoch: () => string
  onSnapshotPublished: (loaded: JournalLoad) => void
}): Promise<void> {
  const stagingDir = await mkdtemp(join(input.journalDir, '.epoch-replacement-'))
  const stagedBlobDigests = new Set<string>()
  const publishedBlobDigests: string[] = []
  let snapshotPublished = false
  let adoptionReported = false
  let publishedLoad: JournalLoad | null = null
  try {
    const epoch = input.mintEpoch()
    const state = createJournalReducerState(input.identity.sessionId, epoch)
    const epochRow: JournalRow = {
      kind: 'epoch',
      reason: input.reason,
      providerHandle: input.identity.providerHandle,
      ...journalRowBase(epoch, 1, input.fence, input.now())
    }
    const rows: JournalRow[] = [epochRow]
    applyJournalRow(state, epochRow)
    let sizeBytes = journalRowByteLength(epochRow)
    await assertStagingCapacity(input, sizeBytes)
    await appendJournalRows(stagingDir, [epochRow])

    for (const item of input.items) {
      sizeBytes += await stageReplacementBlobs({
        journalDir: input.journalDir,
        stagingDir,
        identity: input.identity,
        budget: input.budget,
        stagedBlobDigests,
        blobs: item.blobs ?? []
      })
      const appendTime = input.now()
      const row = buildJournalItemRow({
        state,
        identity: item.identity,
        body: item.body,
        seq: state.lastSequence + 1,
        fence: input.fence,
        ts: item.observedAt ?? appendTime
      })
      assertJournalFence(row.fence, state.highestFence)
      input.budget.assert(row, appendTime, sizeBytes)
      await assertStagingCapacity(input, journalRowByteLength(row))
      await appendJournalRows(stagingDir, [row])
      applyJournalRow(state, row)
      rows.push(row)
      sizeBytes += journalRowByteLength(row)
    }

    const compacted = await compactJournal({
      journalDir: stagingDir,
      physicalQuotaRoot: input.journalDir,
      state,
      tailRows: rows,
      policy: input.compaction,
      now: input.now(),
      maxSessionBytes: input.budget.maxSessionBytes
    })
    // All destination publishes use durable temp files while the staging
    // source and existing finals remain present. Reserve the whole publication
    // peak before touching the live epoch so a later file cannot fail halfway
    // through replacement.
    const stagedSnapshotBytes = (await stat(join(stagingDir, JOURNAL_SNAPSHOT_FILE))).size
    const stagedLogBytes = (await stat(join(stagingDir, JOURNAL_LOG_FILE))).size
    let stagedPublishBytes = stagedSnapshotBytes + stagedLogBytes
    for (const digest of stagedBlobDigests) {
      stagedPublishBytes += (await stat(join(stagingDir, JOURNAL_BLOB_DIR, digest))).size
    }
    await assertJournalPhysicalCapacity({
      journalDir: input.journalDir,
      sessionId: input.identity.sessionId,
      maxBytes: input.budget.maxSessionBytes,
      peakAdditionalBytes: stagedPublishBytes
    })
    for (const digest of stagedBlobDigests) {
      if (
        await publishPreparedBlob(
          stagingDir,
          input.journalDir,
          digest,
          input.identity.sessionId,
          input.budget.maxSessionBytes
        )
      ) {
        publishedBlobDigests.push(digest)
      }
    }
    await publishPreparedFile(
      stagingDir,
      input.journalDir,
      JOURNAL_SNAPSHOT_FILE,
      input.identity.sessionId,
      input.budget.maxSessionBytes
    )
    snapshotPublished = true
    state.oldestSequence = compacted.oldestSequence
    publishedLoad = {
      state,
      tailRows: compacted.tailRows,
      compactedThrough: compacted.compactedThrough,
      readOnly: false,
      corrupt: false,
      malformedRows: 0,
      sizeBytes: 0
    }
    await publishPreparedFile(
      stagingDir,
      input.journalDir,
      JOURNAL_LOG_FILE,
      input.identity.sessionId,
      input.budget.maxSessionBytes
    )
    await pruneJournalBlobs(
      input.journalDir,
      replacementRetainedBlobDigests(state, compacted.tailRows)
    )
  } finally {
    if (!snapshotPublished) {
      for (const digest of publishedBlobDigests) {
        await removeJournalBlob(input.journalDir, digest)
      }
    }
    await rm(stagingDir, { recursive: true, force: true })
    if (snapshotPublished && publishedLoad && !adoptionReported) {
      adoptionReported = true
      input.onSnapshotPublished({
        ...publishedLoad,
        sizeBytes: await journalDirectoryBytes(input.journalDir)
      })
    }
  }
}

function replacementRetainedBlobDigests(
  state: JournalReducerState,
  tailRows: readonly JournalRow[]
): Set<string> {
  const retained = referencedBlobDigests(state)
  for (const row of tailRows) {
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

async function stageReplacementBlobs(input: {
  journalDir: string
  stagingDir: string
  identity: AgentSessionJournalIdentity
  budget: JournalAppendBudget
  stagedBlobDigests: Set<string>
  blobs: readonly { digest: string; payload: string }[]
}): Promise<number> {
  const toStage: { digest: string; payload: string; bytes: number }[] = []
  const unique = new Map(input.blobs.map((blob) => [blob.digest, blob]))
  for (const blob of unique.values()) {
    if (input.stagedBlobDigests.has(blob.digest)) {
      continue
    }
    if ((await journalBlobFileSize(input.journalDir, blob.digest)) !== null) {
      continue
    }
    const bytes = Buffer.byteLength(blob.payload, 'utf8')
    toStage.push({ ...blob, bytes })
  }
  // Reserve all new payloads together. The staging directory lives under the
  // journal root, so the capacity check includes existing session bytes and
  // every other .epoch-replacement-* directory already present.
  const stagedBytes = toStage.reduce((total, blob) => total + blob.bytes, 0)
  await assertStagingCapacity(input, stagedBytes)
  for (const blob of toStage) {
    await putJournalBlob(input.stagingDir, blob.digest, blob.payload)
    input.stagedBlobDigests.add(blob.digest)
  }
  return stagedBytes
}

function assertStagingCapacity(
  input: {
    journalDir: string
    identity: AgentSessionJournalIdentity
    budget: JournalAppendBudget
  },
  additionalBytes: number
): Promise<number> {
  return assertJournalPhysicalCapacity({
    journalDir: input.journalDir,
    sessionId: input.identity.sessionId,
    maxBytes: input.budget.maxSessionBytes,
    peakAdditionalBytes: additionalBytes
  })
}

async function publishPreparedFile(
  stagingDir: string,
  journalDir: string,
  fileName: string,
  sessionId: string,
  maxBytes: number
): Promise<void> {
  await assertJournalPhysicalCapacity({
    journalDir,
    sessionId,
    maxBytes,
    peakAdditionalBytes: (await stat(join(stagingDir, fileName))).size
  })
  const copied = await copyFileDurable(join(stagingDir, fileName), join(journalDir, fileName))
  if (!copied) {
    throw new Error(`prepared journal file disappeared before publish: ${fileName}`)
  }
}

async function publishPreparedBlob(
  stagingDir: string,
  journalDir: string,
  digest: string,
  sessionId: string,
  maxBytes: number
): Promise<boolean> {
  if ((await journalBlobFileSize(journalDir, digest)) !== null) {
    return false
  }
  const size = await journalBlobFileSize(stagingDir, digest)
  if (size === null) {
    throw new Error(`prepared journal blob disappeared before publish: ${digest}`)
  }
  await assertJournalPhysicalCapacity({
    journalDir,
    sessionId,
    maxBytes,
    peakAdditionalBytes: size
  })
  await mkdir(join(journalDir, JOURNAL_BLOB_DIR), { recursive: true })
  const copied = await copyFileDurable(
    join(stagingDir, JOURNAL_BLOB_DIR, digest),
    join(journalDir, JOURNAL_BLOB_DIR, digest)
  )
  if (!copied) {
    throw new Error(`prepared journal blob disappeared before publish: ${digest}`)
  }
  return true
}
