// Stage bounded external-history catch-up without blocking provider open; agents supply only history/view logic.

import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { agentSessionHostStatusBody } from '../../../../shared/agent-session/view/agent-session-host-status-rows'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalLifecycleIdentityMutationInput } from '../../agent-session-journal/writing/journal-lifecycle-mutation'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkBarrier
} from '../journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionHistoryJournal } from '../journal-ingress/structured-agent-session-journal-views'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

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
  expectedCursor?: AgentJournalCursor
}

export type HistoryCatchUpJournalView = { physicalCursor: AgentJournalCursor }

/** A view certifies every named answer against physical progress, including context cuts. */
export async function captureHistoryCatchUpView<View>(
  history: StructuredAgentSessionHistoryJournal,
  read: (physicalCursor: AgentJournalCursor) => Promise<View>
): Promise<View & HistoryCatchUpJournalView> {
  return await history.readInOrder(async () => {
    const physicalCursor = await history.reads.physicalCursor()
    const view = await read(physicalCursor)
    const after = await history.reads.physicalCursor()
    if (physicalCursor.epoch !== after.epoch || physicalCursor.sequence !== after.sequence) {
      throw new Error('stale-history')
    }
    return { ...view, physicalCursor }
  })
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
  view: () => Promise<View>
  history: StructuredAgentSessionHistoryJournal
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
export async function runHistoryCatchUp<View extends HistoryCatchUpJournalView>(input: {
  agentName: string
  scope: string
  sessionId: string
  sink: StructuredAgentSessionEventSink
  signal?: AbortSignal
  assertCurrent?: () => void
  timeoutMs: number
  logger?: StructuredAgentSessionLogger
  readView: (history: StructuredAgentSessionHistoryJournal, signal: AbortSignal) => Promise<View>
  prepare: (context: HistoryCatchUpContext<View>) => Promise<HistoryCatchUpPlan | null>
}): Promise<HistoryCatchUpOutcome> {
  const controller = new AbortController()
  const permit = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.store(permit, 0, 1)
  const revoke = () => Atomics.store(permit, 0, 0)
  controller.signal.addEventListener('abort', revoke, { once: true })
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
    if (!history || !written.ok || !sink.tryAppendTransition) {
      return 'skipped'
    }
    let planned: Promise<View> | undefined
    const view = (): Promise<View> => (planned ??= input.readView(history, controller.signal))
    const plan = await waitForPromiseWithSignal(
      input.prepare({
        view,
        history,
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
    const expectedCursor =
      plan.expectedCursor ??
      (await waitForPromiseWithSignal(view(), controller.signal)).physicalCursor
    check()
    let resolved = false
    const admission = sink.tryAppendTransition({
      lifecycle: true,
      publish: true,
      beforeRun: () => {
        try {
          check()
          return sink.journalHistory?.() === history
        } catch {
          return false
        }
      },
      onResolved: (
        outcomes: readonly ({ kind: 'committed'; wrote: boolean } | { kind: 'dropped' })[]
      ) => {
        resolved = outcomes[0]?.kind === 'committed'
      },
      steps: [
        {
          kind: 'settlement',
          settlementId: plan.settlementId,
          reservedBytes: plan.reservedBytes,
          resolution: {
            kind: 'history-catch-up',
            expectedCursor,
            expectedItems: plan.expectedItems ?? [],
            mutations: plan.mutations,
            permit,
            deadline
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
