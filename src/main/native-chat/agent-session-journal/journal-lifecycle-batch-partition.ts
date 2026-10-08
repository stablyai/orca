import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'
import {
  journalLifecycleMutationRow,
  type JournalLifecycleMutationInput
} from './journal-row-builders'
import type { JournalLifecycleBatchRow, JournalLifecycleMutation } from './journal-row-schema'
import {
  MAX_JOURNAL_LIFECYCLE_BATCH_BYTES,
  MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS
} from './journal-row-schema'

export type JournalLifecycleMutationChunk = {
  settlementId: string
  mutations: JournalLifecycleMutationInput[]
}

export function partitionJournalLifecycleMutations(
  settlementId: string,
  mutations: readonly JournalLifecycleMutationInput[]
): JournalLifecycleMutationChunk[] {
  if (mutations.length === 0) {
    return []
  }
  if (mutations.length === 1) {
    return [{ settlementId, mutations: [mutations[0]] }]
  }
  const chunks: JournalLifecycleMutationInput[][] = []
  const probeId = chunkSettlementId(settlementId, mutations.length - 1, mutations.length)
  let pending: JournalLifecycleMutationInput[] = []
  let pendingBytes = 0
  let pendingVersion = journalRowSchemaVersion([])
  const overheadByVersion = new Map<number, number>()
  const overhead = (version: number): number => {
    let bytes = overheadByVersion.get(version)
    if (bytes === undefined) {
      bytes = serializedLifecycleBatchOverhead(probeId, version)
      overheadByVersion.set(version, bytes)
    }
    return bytes
  }
  for (const mutation of mutations) {
    const bytes = Buffer.byteLength(JSON.stringify(toLifecycleMutationRow(mutation)), 'utf8')
    const version = journalRowSchemaVersion(mutation.kind === 'item' ? [mutation.body] : [])
    const candidateVersion = Math.max(pendingVersion, version)
    const candidateBytes = pendingBytes + bytes + (pending.length > 0 ? 1 : 0)
    if (
      pending.length > 0 &&
      candidateBytes + overhead(candidateVersion) > MAX_JOURNAL_LIFECYCLE_BATCH_BYTES
    ) {
      chunks.push(pending)
      pending = []
      pendingBytes = 0
      pendingVersion = journalRowSchemaVersion([])
    }
    pendingBytes += bytes + (pending.length > 0 ? 1 : 0)
    pendingVersion = Math.max(pendingVersion, version)
    pending.push(mutation)
    if (pending.length === MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS) {
      chunks.push(pending)
      pending = []
      pendingBytes = 0
      pendingVersion = journalRowSchemaVersion([])
    }
  }
  if (pending.length > 0) {
    chunks.push(pending)
  }
  return chunks.map((chunk, index) => ({
    settlementId:
      chunks.length === 1 ? settlementId : chunkSettlementId(settlementId, index, chunks.length),
    mutations: chunk
  }))
}

function chunkSettlementId(settlementId: string, index: number, total: number): string {
  return `${settlementId}:${index + 1}/${total}`
}

function serializedLifecycleBatchOverhead(settlementId: string, version: number): number {
  const row: JournalLifecycleBatchRow = {
    v: version,
    kind: 'lifecycle-batch',
    epoch: '00000000-0000-4000-8000-000000000000',
    seq: Number.MAX_SAFE_INTEGER,
    fence: Number.MAX_SAFE_INTEGER,
    ts: Number.MAX_SAFE_INTEGER,
    settlementId,
    mutations: []
  }
  return Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
}

/** Sized as a Stop may write it (`turnEndAfterStop`), so the chunk built from it still fits. */
function sizedAsStopped(mutation: JournalLifecycleMutationInput): JournalLifecycleMutationInput {
  if (
    mutation.kind !== 'item' ||
    mutation.body.kind !== 'turn' ||
    mutation.body.state !== 'interrupted' ||
    mutation.body.outcome !== undefined
  ) {
    return mutation
  }
  return { ...mutation, body: { ...mutation.body, outcome: 'cancellation' } }
}

function toLifecycleMutationRow(mutation: JournalLifecycleMutationInput): JournalLifecycleMutation {
  return journalLifecycleMutationRow(
    sizedAsStopped(mutation),
    agentJournalItemKey(mutation.identity),
    Number.MAX_SAFE_INTEGER
  )
}
