import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
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
  const chunks: JournalLifecycleMutationInput[][] = []
  const probeId = chunkSettlementId(settlementId, mutations.length - 1, mutations.length)
  let pending: JournalLifecycleMutationInput[] = []
  for (const mutation of mutations) {
    const candidate = [...pending, mutation]
    if (pending.length > 0 && !serializedLifecycleBatchFits(probeId, candidate)) {
      chunks.push(pending)
      pending = [mutation]
    } else {
      pending = candidate
    }
    if (pending.length === MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS) {
      chunks.push(pending)
      pending = []
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

function serializedLifecycleBatchFits(
  settlementId: string,
  mutations: readonly JournalLifecycleMutationInput[]
): boolean {
  const row: JournalLifecycleBatchRow = {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    kind: 'lifecycle-batch',
    epoch: '00000000-0000-4000-8000-000000000000',
    seq: Number.MAX_SAFE_INTEGER,
    fence: Number.MAX_SAFE_INTEGER,
    ts: Number.MAX_SAFE_INTEGER,
    settlementId,
    mutations: mutations.map(lifecycleMutationRowShape)
  }
  return Buffer.byteLength(JSON.stringify(row), 'utf8') + 1 <= MAX_JOURNAL_LIFECYCLE_BATCH_BYTES
}

function lifecycleMutationRowShape(
  mutation: JournalLifecycleMutationInput
): JournalLifecycleMutation {
  const itemId = agentJournalItemKey(mutation.identity)
  return mutation.kind === 'item'
    ? {
        kind: 'item',
        itemId,
        revision: Number.MAX_SAFE_INTEGER,
        body: mutation.body
      }
    : { kind: 'tombstone', itemId, revision: Number.MAX_SAFE_INTEGER }
}
