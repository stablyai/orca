import { createHash } from 'node:crypto'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalLifecycleIdentityMutationInput } from '../../agent-session-journal/writing/journal-lifecycle-mutation'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionHistoryReplacement } from '../journal-ingress/structured-agent-session-history-replacement'
import type { NativeCopyOrigin } from '../../agent-session-journal/context-epochs/journal-history-origin'

export const HISTORY_CATCH_UP_MAX_OPERATIONS = 1_024
export const HISTORY_CATCH_UP_MAX_BYTES = 16 * 1024 * 1024

export class HistoryCatchUpCapacityError extends Error {
  constructor() {
    super('too-large')
  }
}

export type HistoryCatchUpReplacementPlan = {
  kind: 'replace'
  reservedBytes: number
  operation: Omit<StructuredAgentSessionHistoryReplacement['operation'], 'guard'>
}

export type ExpectedHistoryItem = {
  key: string
  canonicalItemId: string
  /** Read precondition only; the journal assigns the written revision. */
  revision: number
}

export type HistoryCatchUpPlan = {
  settlementId: string
  mutations: JournalLifecycleIdentityMutationInput[]
  keys: string[]
  reservedBytes: number
  expectedItems?: readonly ExpectedHistoryItem[]
  expectedCursor?: AgentJournalCursor
  historyOrigin?: NativeCopyOrigin
}

/** Stage the whole bounded plan before any sink admission. */
export function createHistoryCatchUpBatch() {
  const mutations: JournalLifecycleIdentityMutationInput[] = []
  const keys: string[] = []
  const expectedItems: ExpectedHistoryItem[] = []
  let bytes = 0
  let admissions = 0
  const admit = (serialized: string, expected?: ExpectedHistoryItem) => {
    bytes += Buffer.byteLength(serialized, 'utf8') + 1
    if (expected) {
      bytes += Buffer.byteLength(JSON.stringify(expected), 'utf8') + 1
    }
    if (admissions >= HISTORY_CATCH_UP_MAX_OPERATIONS || bytes > HISTORY_CATCH_UP_MAX_BYTES) {
      throw new HistoryCatchUpCapacityError()
    }
    admissions++
    if (expected) {
      expectedItems.push(expected)
    }
  }
  const stage = (
    mutation: JournalLifecycleIdentityMutationInput,
    serialized: string,
    expected?: ExpectedHistoryItem
  ) => {
    admit(serialized, expected)
    mutations.push(mutation)
    keys.push(agentJournalItemKey(mutation.identity))
  }
  return {
    get size(): number {
      return mutations.length
    },
    push(mutation: JournalLifecycleIdentityMutationInput, serialized = JSON.stringify(mutation)) {
      stage(mutation, serialized)
    },
    revise(
      mutation: Extract<JournalLifecycleIdentityMutationInput, { kind: 'item' }>,
      expected: Omit<ExpectedHistoryItem, 'key'>
    ) {
      stage(mutation, JSON.stringify(mutation), {
        ...expected,
        key: agentJournalItemKey(mutation.identity)
      })
    },
    expectItem(key: string, expected: Omit<ExpectedHistoryItem, 'key'>) {
      const item = { ...expected, key }
      admit(JSON.stringify(item))
      expectedItems.push(item)
    },
    /** Digest imported identity so retries share one settlement ID. */
    finish(
      settlementPrefix: string,
      digestOf: unknown,
      historyOrigin?: NativeCopyOrigin
    ): HistoryCatchUpPlan {
      const expectations = {
        ...(expectedItems.length ? { expectedItems: [...expectedItems] } : {}),
        ...(historyOrigin ? { historyOrigin } : {})
      }
      const content = expectedItems.length ? [digestOf, expectedItems, mutations] : digestOf
      const digest = createHash('sha256')
        .update(JSON.stringify(historyOrigin ? [content, historyOrigin] : content))
        .digest('hex')
      const settlementId = `${settlementPrefix}:${digest}`
      // Include batch-envelope cost and the transition’s publication byte.
      const reservedBytes =
        Buffer.byteLength(JSON.stringify({ settlementId, mutations, ...expectations }), 'utf8') +
        512
      if (reservedBytes + 1 > HISTORY_CATCH_UP_MAX_BYTES) {
        throw new HistoryCatchUpCapacityError()
      }
      return { settlementId, mutations, keys: [...keys], reservedBytes, ...expectations }
    }
  }
}
