import {
  StructuredAgentSessionInputNotAdmitted,
  type StructuredAgentSessionInputAdmission
} from './structured-agent-session-input-admission'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { continuingStructuredAgentSessionInput } from './structured-agent-session-handing-over'
import type { StructuredAgentSessionDeliveryLoopDeps } from './structured-agent-session-delivery-loop'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import {
  beginSubmissionHandover,
  type StructuredAgentSessionPendingHandover
} from './structured-agent-session-handover'
import { structuredAgentSessionCommandRunning } from './structured-agent-session-command-turn'
import {
  providerStartupFailureFact,
  structuredAgentSessionStartFailure
} from './structured-agent-session-failure-text'
import {
  refusedStructuredAgentSessionStart,
  structuredAgentSessionStartFailureRow,
  type startThatFailedWhileQueued
} from './structured-agent-session-start-failure-row'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import { sameProviderChild } from './structured-agent-session-provider-child'

type StartFailure = NonNullable<ReturnType<typeof startThatFailedWhileQueued>>

/** The scheduler's selected input keeps one handover while its exact child binding changes. */
export function beginStructuredAgentSessionInputHandover(
  deps: StructuredAgentSessionDeliveryLoopDeps,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  awaitedChild: StructuredAgentSessionProviderChild,
  next: AgentJournalSubmission,
  isDisposed: () => boolean
): Promise<StructuredAgentSessionPendingHandover | null> {
  let binding = awaitedChild
  let recorder = deps.recordRanOptions?.(sessionId, binding.fence)
  const ownsInput = () =>
    deps.sessions.get(sessionId) === session &&
    session.journal
      .submissions()
      .some((s) => s.clientMessageId === next.clientMessageId && s.dispatchState === 'pending')
  const isBound = () => deps.sessions.get(sessionId) === session && session.child === binding
  const isCurrent = () => isBound() && !binding.close
  const validate = (signal?: AbortSignal) => {
    const work = deps.currentWork(sessionId)
    if (
      signal?.aborted ||
      isDisposed() ||
      !isCurrent() ||
      binding.phase !== 'ready' ||
      deps.stopping(sessionId) ||
      !ownsInput() ||
      (work && structuredAgentSessionCommandRunning(work))
    ) {
      const ended = session.lastEndedChild
      throw new StructuredAgentSessionInputNotAdmitted({
        state: 'rejected',
        ...structuredAgentSessionStartFailure(
          (ended && sameProviderChild(ended, binding)
            ? structuredAgentSessionEndedChildFailure(ended)
            : null) ?? {
            failure: agentSessionFailureFact('cancelled', { neverReachedAgent: true })
          },
          deps.failureTextContext(sessionId)
        )
      })
    }
  }
  return beginSubmissionHandover(
    {
      sessionId,
      journal: session.journal,
      fence: awaitedChild.fence,
      adapter: deps.adapter,
      agents: deps.agents,
      failureTextContext: deps.failureTextContext(sessionId),
      record: () => deps.record(sessionId),

      admitFreshInput: async (enqueue, signal, prepare) => {
        let admission: StructuredAgentSessionInputAdmission | undefined
        const invoked = deps.serialize(sessionId, async () => {
          validate(signal)
          const body = await prepare(binding.fence)
          validate(signal)
          const mode = deps.immediatePermission?.(sessionId)
          if (!mode) {
            throw new Error('input handover has no permission choice')
          }
          admission = enqueue(
            mode,
            deps.retainedWork?.(sessionId, next.clientMessageId) === true,
            body
          )
          return admission
        })
        try {
          return await waitForPromiseWithSignal(invoked, signal)
        } catch (error) {
          // Enqueue is synchronous; Promise delivery must not turn an actual write into a withdrawal.
          if (admission?.kind === 'sent') {
            return admission
          }
          validate(signal)
          throw error
        }
      },
      continueInput: async (signal, rebind) => {
        const failed = async (
          cause: StartFailure['cause'],
          fence: number,
          startKey = next.clientMessageId
        ) => {
          const words = structuredAgentSessionStartFailure(
            cause,
            deps.failureTextContext(sessionId)
          )
          if (!('failure' in cause && cause.failure.kind === 'cancelled')) {
            await session.journal.appendLifecycleBatch({
              settlementId: `start-failure:${startKey}`,
              fence,
              recovered: true,
              mutations: [structuredAgentSessionStartFailureRow(startKey, words)]
            })
          }
          return {
            kind: 'failed' as const,
            fence,
            outcome: { state: 'rejected' as const, ...words }
          }
        }
        try {
          const claim = await waitForPromiseWithSignal(
            deps.serialize(sessionId, async () => {
              validate(signal)
              if (
                !ownsInput() ||
                !session.journal
                  .submissions()
                  .some(
                    (s) => s.clientMessageId === next.clientMessageId && s.fence === binding.fence
                  ) ||
                !continuingStructuredAgentSessionInput(session.journal, next.clientMessageId)
              ) {
                throw new Error('input continuation no longer owns its submission')
              }
              await deps.retireOutgrownChild(sessionId, next.clientMessageId)
              signal?.throwIfAborted()
              if (!ownsInput() || (session.child && session.child !== binding)) {
                throw new Error('input continuation lost its provider binding')
              }
              return deps.startProviderChild(sessionId, next.clientMessageId)
            }),
            signal
          )
          const started = await waitForPromiseWithSignal(claim.outcome, signal)
          if (!started.ok) {
            return deps.serialize(sessionId, () =>
              failed(
                started.aborted
                  ? { failure: agentSessionFailureFact('cancelled') }
                  : refusedStructuredAgentSessionStart(deps.record(sessionId), started).cause,
                deps.conversationFence(sessionId)
              )
            )
          }
          const child = deps.sessions.get(sessionId)?.child
          const rebound = await waitForPromiseWithSignal(
            deps.serialize(sessionId, async () => {
              signal?.throwIfAborted()
              const current = deps.sessions.get(sessionId)?.child
              if (
                !ownsInput() ||
                !current ||
                current !== child ||
                current.close ||
                current.phase !== 'ready'
              ) {
                const ended = session.lastEndedChild
                return failed(
                  (ended && (!child || sameProviderChild(ended, child))
                    ? structuredAgentSessionEndedChildFailure(ended)
                    : undefined) ?? { failure: agentSessionFailureFact('startFailed') },
                  child?.fence ?? deps.conversationFence(sessionId),
                  child?.generation ?? next.clientMessageId
                )
              }
              binding = current
              recorder = deps.recordRanOptions?.(sessionId, binding.fence)
              await rebind(current.fence)
              validate(signal)
              return null
            }),
            signal
          )
          if (rebound) {
            return rebound
          }
          return { kind: 'ready', isCurrent }
        } catch (error) {
          if (signal?.aborted) {
            return deps.serialize(sessionId, () => {
              const ended = session.lastEndedChild
              return failed(
                (ended?.cause === 'exit'
                  ? structuredAgentSessionEndedChildFailure(ended)
                  : null) ?? {
                  failure: agentSessionFailureFact('cancelled')
                },
                deps.conversationFence(sessionId)
              )
            })
          }
          return deps.serialize(sessionId, () =>
            failed(
              {
                failure: signal?.aborted
                  ? agentSessionFailureFact('cancelled')
                  : providerStartupFailureFact(error)
              },
              deps.conversationFence(sessionId)
            )
          )
        }
      },

      currentWork: () => deps.currentWork(sessionId),
      childWork: () => deps.readChildWork(sessionId),
      childWorkOpen: () => deps.childWorkOpen(sessionId),
      now: deps.now,
      acquireAborts: deps.acquireAborts,
      deliveryOrder: deps.deliveryOrder,
      workChanged: () => deps.workChanged?.(sessionId),
      holdClosedInput: (id, fence, cause) =>
        deps.holdClosedInput?.(
          sessionId,
          id,
          session.journal.submission(id)?.fence ?? fence,
          cause
        ) ?? Promise.resolve(),
      settleEndedInput: async (owner) => {
        if (session.lastEndedChild && sameProviderChild(session.lastEndedChild, binding)) {
          await deps.settleLeftovers?.(sessionId, owner)
        }
      },
      get recordRanOptions() {
        return recorder
      }
    },
    next,
    // Re-read right before the provider call, which runs outside the serialize.
    isCurrent,
    isBound
  )
}
