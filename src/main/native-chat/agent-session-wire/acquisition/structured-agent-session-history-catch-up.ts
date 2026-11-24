import type {
  HistoryCatchUpPlan,
  HistoryCatchUpReplacementPlan
} from './structured-agent-session-history-catch-up-plan'
export {
  HISTORY_CATCH_UP_MAX_OPERATIONS,
  HISTORY_CATCH_UP_MAX_BYTES,
  HistoryCatchUpCapacityError,
  createHistoryCatchUpBatch,
  type HistoryCatchUpPlan,
  type HistoryCatchUpReplacementPlan,
  type ExpectedHistoryItem
} from './structured-agent-session-history-catch-up-plan'
// Stage bounded external-history catch-up without blocking provider open; agents supply only history/view logic.

import { setImmediate } from 'node:timers/promises'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import { agentSessionHostStatusBody } from '../../../../shared/agent-session/view/agent-session-host-status-rows'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkBarrier
} from '../journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionHistoryJournal } from '../journal-ingress/structured-agent-session-journal-views'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

export function continuedOutsideRecordId(anchor: string): string {
  return `continued-outside:${anchor}`
}

export function continuedOutsideNotice(
  rewound: boolean,
  capacity?: 'recent' | 'unloaded'
): AgentJournalItemBody {
  return agentSessionHostStatusBody(
    capacity === 'recent'
      ? 'continued-outside-recent'
      : capacity === 'unloaded'
        ? 'continued-outside-unloaded'
        : rewound
          ? 'continued-outside-rewound'
          : 'continued-outside'
  )
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
  prepare: (
    context: HistoryCatchUpContext<View>
  ) => Promise<HistoryCatchUpPlan | HistoryCatchUpReplacementPlan | null>
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
    const beforeRun = () => {
      try {
        check()
        return sink.journalHistory?.() === history
      } catch {
        return false
      }
    }
    if ('operation' in plan) {
      if (!sink.tryReplaceHistory) {
        warn('replacement-unavailable')
        return 'skipped'
      }
      const expectedCursor = (await view()).physicalCursor
      check()
      let resolved = false
      const admission = sink.tryReplaceHistory({
        reservedBytes: plan.reservedBytes,
        operation: { ...plan.operation, guard: { expectedCursor, permit, deadline } },
        beforeRun,
        onResolved: (outcome) => {
          resolved = outcome === 'committed'
        }
      })
      if (!admission.accepted) {
        warn(admission.reason)
        return 'skipped'
      }
      const committed = await waitForPromiseWithSignal(
        sink.written?.() ?? Promise.resolve<StructuredAgentSessionSinkBarrier>({ ok: true }),
        controller.signal
      )
      if (!committed.ok || !resolved) {
        warn(
          committed.ok ? 'stale-history' : 'write-failed',
          committed.ok ? undefined : committed.error
        )
        return 'skipped'
      }
      return 'committed'
    }
    const expectedCursor =
      plan.expectedCursor ??
      (await waitForPromiseWithSignal(view(), controller.signal)).physicalCursor
    check()
    let resolved = false
    const admission = sink.tryAppendTransition({
      lifecycle: true,
      publish: true,
      beforeRun,
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
            historyOrigin: plan.historyOrigin,
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
