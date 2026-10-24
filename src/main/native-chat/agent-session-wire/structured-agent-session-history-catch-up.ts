// Stage bounded external-history catch-up without blocking provider open; agents supply only history/view logic.

import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { agentSessionHostStatusBody } from '../../../shared/agent-session-host-status-rows'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { JournalLifecycleIdentityMutationInput } from '../agent-session-journal/journal-lifecycle-mutation'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionHistoryJournal,
  StructuredAgentSessionSinkBarrier
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionTransitionJournal } from './structured-agent-session-transition'

export const HISTORY_CATCH_UP_MAX_OPERATIONS = 1_024
export const HISTORY_CATCH_UP_MAX_BYTES = 16 * 1024 * 1024

export function continuedOutsideRecordId(anchor: string): string {
  return `continued-outside:${anchor}`
}

export function continuedOutsideNotice(rewound: boolean): AgentJournalItemBody {
  return agentSessionHostStatusBody(rewound ? 'continued-outside-rewound' : 'continued-outside')
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
      throw new Error('too-large')
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
    finish(settlementPrefix: string, digestOf: unknown): HistoryCatchUpPlan {
      const expectations = expectedItems.length ? { expectedItems: [...expectedItems] } : {}
      const content = expectedItems.length ? [digestOf, expectedItems, mutations] : digestOf
      const digest = createHash('sha256').update(JSON.stringify(content)).digest('hex')
      const settlementId = `${settlementPrefix}:${digest}`
      // Include batch-envelope cost and the transition’s publication byte.
      const reservedBytes =
        Buffer.byteLength(JSON.stringify({ settlementId, mutations, ...expectations }), 'utf8') +
        512
      if (reservedBytes + 1 > HISTORY_CATCH_UP_MAX_BYTES) {
        throw new Error('too-large')
      }
      return { settlementId, mutations, keys: [...keys], reservedBytes, ...expectations }
    }
  }
}

export type HistoryCatchUpContext<View> = {
  /** Read journal lazily so empty provider history needs no journal scan. */
  view: () => View
  history: StructuredAgentSessionHistoryJournal
  journal: StructuredAgentSessionTransitionJournal
  signal: AbortSignal
  deadline: number
  /** Enforce cancellation, deadline and current invocation before effects. */
  check: () => void
  yieldTurn: () => Promise<void>
  warn: (reason: string, error?: unknown) => void
}

/** `checked`: an explicit empty plan validated; `nothing`: no plan or coverage proof. */
export type HistoryCatchUpOutcome = 'committed' | 'checked' | 'nothing' | 'skipped'

/** Optional reconciliation never gates provider open; an abandoned invocation cannot later write. */
export async function runHistoryCatchUp<View>(input: {
  agentName: string
  scope: string
  sessionId: string
  sink: StructuredAgentSessionEventSink
  signal?: AbortSignal
  assertCurrent?: () => void
  timeoutMs: number
  logger?: StructuredAgentSessionLogger
  readView: (history: StructuredAgentSessionHistoryJournal) => View
  /** Reject commits if saved facts changed since planning. */
  sameView: (planned: View, current: View) => boolean
  prepare: (context: HistoryCatchUpContext<View>) => Promise<HistoryCatchUpPlan | null>
}): Promise<HistoryCatchUpOutcome> {
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) {
    abort()
  }
  const deadline = Date.now() + input.timeoutMs
  const timer = setTimeout(() => controller.abort(new Error('catch-up-deadline')), input.timeoutMs)
  const check = () => {
    if (controller.signal.aborted || Date.now() >= deadline) {
      throw new Error('catch-up-cancelled')
    }
    input.assertCurrent?.()
  }
  const warn = (reason: string, error?: unknown) =>
    input.logger?.warn(`${input.agentName} chat did not catch up on turns made outside it`, {
      scope: input.scope,
      sessionId: input.sessionId,
      reason,
      ...(error === undefined ? {} : { error })
    })
  const { sink } = input
  try {
    check()
    const written = await waitForPromiseWithSignal(
      sink.written?.() ?? Promise.resolve({ ok: true }),
      controller.signal
    )
    check()
    const history = sink.journalHistory?.()
    const journal = sink.journalItems?.()
    if (!history || !journal || !written.ok || !sink.tryAppendTransition) {
      return 'skipped'
    }
    const epoch = history.epoch
    let planned: { view: View } | undefined
    const view = (): View => (planned ??= { view: input.readView(history) }).view
    const plan = await waitForPromiseWithSignal(
      input.prepare({
        view,
        history,
        journal,
        signal: controller.signal,
        deadline,
        check,
        yieldTurn: () => setImmediate(),
        warn
      }),
      controller.signal
    )
    check()
    if (!plan) {
      return 'nothing'
    }
    let resolved = false
    const admission = sink.tryAppendTransition({
      lifecycle: true,
      publish: true,
      steps: [
        {
          kind: 'settlement',
          settlementId: plan.settlementId,
          reservedBytes: plan.reservedBytes,
          resolve: (current) => {
            try {
              check()
            } catch {
              return []
            }
            if (
              current.epoch !== epoch ||
              sink.journalHistory?.() !== history ||
              !input.sameView(view(), input.readView(history))
            ) {
              return []
            }
            const verified = new Set<string>()
            for (const expected of plan.expectedItems ?? []) {
              const canonical = current.canonicalItemId(expected.key)
              if (
                verified.has(expected.key) ||
                canonical !== expected.canonicalItemId ||
                current.item(canonical)?.revision !== expected.revision
              ) {
                return []
              }
              verified.add(expected.key)
            }
            // Submission aliases can make otherwise distinct canonical keys collide.
            const seen = new Set<string>()
            for (const mutation of plan.mutations) {
              const key = agentJournalItemKey(mutation.identity)
              const canonical = current.canonicalItemId(key)
              if (seen.has(canonical) || (!verified.has(key) && current.item(canonical) !== null)) {
                return []
              }
              seen.add(canonical)
            }
            resolved = true
            return plan.mutations
          }
        }
      ]
    })
    if (!admission.accepted) {
      warn(admission.reason)
      return 'skipped'
    }
    // Bound commit barriers too; hung sinks cannot block provider open.
    const committed = await waitForPromiseWithSignal(
      sink.written?.() ?? Promise.resolve<StructuredAgentSessionSinkBarrier>({ ok: true }),
      controller.signal
    )
    if (!committed.ok) {
      warn('write-failed', committed.error)
      return 'skipped'
    }
    if (!resolved) {
      warn('stale-history')
      return 'skipped'
    }
    return plan.mutations.length ? 'committed' : 'checked'
  } catch (error) {
    warn('import-skipped', error)
    return 'skipped'
  } finally {
    controller.abort()
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abort)
  }
}
