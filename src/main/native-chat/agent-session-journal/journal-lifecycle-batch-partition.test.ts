import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  journalRowSchemaVersion
} from '../../../shared/agent-session-journal-types'
import { partitionJournalLifecycleMutations } from './journal-lifecycle-batch-partition'
import { createJournalReducerState } from './journal-reducer'
import {
  journalLifecycleBatchRowBuilder,
  journalLifecycleMutationRow,
  type JournalLifecycleMutationInput
} from './journal-row-builders'
import {
  MAX_JOURNAL_LIFECYCLE_BATCH_BYTES,
  MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS,
  parseJournalRow,
  serializeJournalRow,
  type JournalLifecycleBatchRow
} from './journal-row-schema'

const EPOCH = '00000000-0000-4000-8000-000000000000'

function item(
  index: number,
  text: string
): Extract<JournalLifecycleMutationInput, { kind: 'item' }> {
  return {
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: `item:${index}` },
    body: { kind: 'tool-call', name: 'shell', input: { command: text }, state: 'failed' },
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}

// Frozen size probe from the previous partitioner, including Stop's larger turn outcome.
function previousProbe(settlementId: string, mutations: readonly JournalLifecycleMutationInput[]) {
  const row: JournalLifecycleBatchRow = {
    v: journalRowSchemaVersion(
      mutations.flatMap((mutation) => (mutation.kind === 'item' ? [mutation.body] : []))
    ),
    kind: 'lifecycle-batch',
    epoch: EPOCH,
    seq: Number.MAX_SAFE_INTEGER,
    fence: Number.MAX_SAFE_INTEGER,
    ts: Number.MAX_SAFE_INTEGER,
    settlementId,
    mutations: mutations.map((mutation) =>
      journalLifecycleMutationRow(
        mutation.kind === 'item' &&
          mutation.body.kind === 'turn' &&
          mutation.body.state === 'interrupted' &&
          mutation.body.outcome === undefined
          ? { ...mutation, body: { ...mutation.body, outcome: 'cancellation' } }
          : mutation,
        agentJournalItemKey(mutation.identity),
        Number.MAX_SAFE_INTEGER
      )
    )
  }
  return Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
}

function previousPartition(
  settlementId: string,
  mutations: readonly JournalLifecycleMutationInput[]
) {
  const chunks: JournalLifecycleMutationInput[][] = []
  const probeId = `${settlementId}:${mutations.length}/${mutations.length}`
  let pending: JournalLifecycleMutationInput[] = []
  for (const mutation of mutations) {
    const candidate = [...pending, mutation]
    if (
      pending.length > 0 &&
      previousProbe(probeId, candidate) > MAX_JOURNAL_LIFECYCLE_BATCH_BYTES
    ) {
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
  return chunks.map((mutations, index) => ({
    settlementId:
      chunks.length === 1 ? settlementId : `${settlementId}:${index + 1}/${chunks.length}`,
    mutations
  }))
}

afterEach(() => vi.restoreAllMocks())

describe('journal lifecycle batch partitioning', () => {
  it('leaves empty and singleton batches uninspected, including an oversized singleton', () => {
    const oversized = item(0, 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES))
    const stringify = vi.spyOn(JSON, 'stringify')
    expect(partitionJournalLifecycleMutations('one', [])).toEqual([])
    expect(partitionJournalLifecycleMutations('one', [oversized])).toEqual([
      { settlementId: 'one', mutations: [oversized] }
    ])
    expect(stringify).not.toHaveBeenCalled()
  })

  it('preserves the mutation cap and the oversized leading mutation rule', () => {
    const small = Array.from({ length: 401 }, (_, index) => item(index, 'small'))
    expect(
      partitionJournalLifecycleMutations('count', small).map((chunk) => chunk.mutations.length)
    ).toEqual([200, 200, 1])
    const oversized = [item(0, 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES)), item(1, 'small')]
    expect(partitionJournalLifecycleMutations('large', oversized)).toEqual(
      previousPartition('large', oversized)
    )
  })

  it('keeps exact UTF-8 byte-boundary admission through the production row builder', () => {
    const settlementId = 'boundary:"\\😀'
    const mutations = [item(0, ''), item(1, '')]
    const available =
      MAX_JOURNAL_LIFECYCLE_BATCH_BYTES - previousProbe(`${settlementId}:2/2`, mutations)
    const atLimit = [item(0, 'x'.repeat(available)), item(1, '')]
    const overLimit = [item(0, 'x'.repeat(available + 1)), item(1, '')]
    expect(partitionJournalLifecycleMutations(settlementId, atLimit)).toHaveLength(1)
    expect(partitionJournalLifecycleMutations(settlementId, overLimit)).toHaveLength(2)
    const state = createJournalReducerState('session', EPOCH)
    for (const mutations of [atLimit, overLimit]) {
      for (const chunk of partitionJournalLifecycleMutations(settlementId, mutations)) {
        const row = journalLifecycleBatchRowBuilder(
          () => state,
          chunk.settlementId,
          chunk.mutations,
          {
            fence: 1,
            recovered: true
          }
        )(1, 1)
        const serialized = serializeJournalRow(row)
        expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES)
        expect(parseJournalRow(serialized).ok).toBe(true)
      }
    }
  })

  it('matches the previous chunks for seeded mixed mutations, linkage and JSON escaping', () => {
    let seed = 82413
    const random = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % limit
    }
    const symbols = ['x', '"\\\n\t', '界😀', '\uD800', '\0\r\u001f']
    for (let fixture = 0; fixture < 48; fixture++) {
      const text = symbols[random(symbols.length)].repeat(random(8_000))
      const mutations = Array.from(
        { length: random(230) },
        (_, index): JournalLifecycleMutationInput => {
          const identity = { provider: 'orca' as const, clientMessageId: `item:"\\界😀:${index}` }
          if (index % 23 === 0) {
            return { kind: 'tombstone', identity }
          }
          if (index % 19 === 0) {
            return {
              kind: 'item',
              identity,
              body: { kind: 'turn', turnId: `turn:${index}`, state: 'interrupted', startedAt: 1 },
              turnScope: AGENT_JOURNAL_THREAD_SCOPE
            }
          }
          return {
            ...item(index, text),
            identity,
            linkage: {
              agentId: 'child',
              parentAgentId: 'parent',
              providerParentRef: 'call:"\\界😀',
              producerKind: 'background',
              attempt: 2
            }
          }
        }
      )
      const settlementId = `settle:"\\\n😀:${'q'.repeat(random(2_000))}`
      const actual = partitionJournalLifecycleMutations(settlementId, mutations)
      expect(actual).toEqual(previousPartition(settlementId, mutations))
      const flattened = actual.flatMap((chunk) => chunk.mutations)
      expect(flattened).toHaveLength(mutations.length)
      for (let index = 0; index < flattened.length; index++) {
        expect(flattened[index]).toBe(mutations[index])
      }
    }
  })

  it('keeps serialization work proportional to the settled payload', () => {
    const mutations = Array.from({ length: 128 }, (_, index) => item(index, 'x'.repeat(16 * 1024)))
    const payloadBytes = Buffer.byteLength(JSON.stringify(mutations))
    const stringify = JSON.stringify
    let serializedBytes = 0
    vi.spyOn(JSON, 'stringify').mockImplementation((value) => {
      const encoded = stringify(value)
      if (encoded !== undefined) {
        serializedBytes += Buffer.byteLength(encoded)
      }
      return encoded
    })
    const chunks = partitionJournalLifecycleMutations('linear', mutations)
    vi.restoreAllMocks()
    expect(chunks.flatMap((chunk) => chunk.mutations)).toEqual(mutations)
    expect(serializedBytes).toBeLessThan(payloadBytes * 3)
  })
})
