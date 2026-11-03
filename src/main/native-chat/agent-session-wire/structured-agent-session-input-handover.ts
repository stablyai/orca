import {
  StructuredAgentSessionInputNotAdmitted,
  type StructuredAgentSessionInputAdmission
} from './structured-agent-session-input-admission'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
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
import { structuredAgentSessionChildAcceptsInput } from './structured-agent-session-input-readiness'
import {
  providerStartupFailureFact,
  structuredAgentSessionStartFailure
} from './structured-agent-session-failure-text'
import {
  refusedStructuredAgentSessionStart,
  failedStructuredAgentSessionInputContinuation,
  type startThatFailedWhileQueued
} from './structured-agent-session-start-failure-row'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import { sameProviderChild } from './structured-agent-session-provider-child'
import { previousExitUnverifiableRefusal } from './structured-agent-session-child-close'

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
    session.journal.submission(next.clientMessageId)?.dispatchState === 'pending'
  const isBound = () => deps.sessions.get(sessionId) === session && session.child === binding
  const isCurrent = () => isBound() && !binding.close
  const validate = (signal?: AbortSignal) => {
    if (
      signal?.aborted ||
      isDisposed() ||
      !ownsInput() ||
      !structuredAgentSessionChildAcceptsInput({
        child: binding,
        current: isBound(),
        stopping: deps.stopping(sessionId),
        work: deps.currentWork(sessionId)
      })
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

      admitFreshInput: async (enqueue, signal, prepare, kind = 'fresh') => {
        let admission: StructuredAgentSessionInputAdmission | undefined
        const invoked = deps.serialize(sessionId, async () => {
          validate(signal)
          const body = kind === 'fresh' ? await prepare(binding.fence) : undefined
          validate(signal)
          const mode = deps.immediatePermission?.(sessionId)
          if (
            mode &&
            (deps.adapter.permissionModeRequiresAcquisition?.(sessionId, mode) ??
              mode !== binding.permissionMode)
          ) {
            return { kind: 'acquire' as const, reason: 'permission' as const }
          }
          admission = enqueue(
            mode ?? 'own',
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
      continueInput: async (signal, rebind, reason = 'auto') => {
        const failed = (
          cause: StartFailure['cause'],
          fence: number,
          startKey = next.clientMessageId
        ) =>
          failedStructuredAgentSessionInputContinuation(
            session.journal,
            deps.failureTextContext(sessionId),
            cause,
            fence,
            startKey
          )
        try {
          const mode = await waitForPromiseWithSignal(
            deps.serialize(sessionId, async () => {
              validate(signal)
              return deps.immediatePermission?.(sessionId)
            }),
            signal
          )
          const transitionNeeded =
            mode &&
            (reason === 'auto' ||
              mode !== binding.permissionMode ||
              deps.adapter.permissionModeRequiresAcquisition?.(sessionId, mode) !== undefined)
          if (
            transitionNeeded &&
            deps.adapter.settlePermissionTransition &&
            !(await waitForPromiseWithSignal(
              deps.adapter.settlePermissionTransition({
                sessionId,
                fence: binding.fence,
                mode,
                signal
              }),
              signal
            ))
          ) {
            return deps.serialize(sessionId, () =>
              failed(
                {
                  failure: agentSessionFailureFact('restartFailed', { neverReachedAgent: true })
                },
                binding.fence
              )
            )
          }
          const claim = await waitForPromiseWithSignal(
            deps.serialize(sessionId, async () => {
              validate(signal)
              if (
                !session.journal
                  .submissions()
                  .some(
                    (s) => s.clientMessageId === next.clientMessageId && s.fence === binding.fence
                  ) ||
                !continuingStructuredAgentSessionInput(session.journal, next.clientMessageId)
              ) {
                throw new Error('input continuation no longer owns its submission')
              }
              const latest = deps.immediatePermission?.(sessionId)
              const acquire =
                (reason === 'auto' && latest === 'auto') ||
                (!!latest &&
                  (deps.adapter.permissionModeRequiresAcquisition?.(sessionId, latest) ??
                    latest !== binding.permissionMode))
              if (!acquire) {
                return null
              }
              await (deps.stopPermissionTransitionChild
                ? deps.stopPermissionTransitionChild(sessionId)
                : deps.retireOutgrownChild(sessionId, next.clientMessageId))
              signal?.throwIfAborted()
              const ended = session.lastEndedChild
              if (
                !ownsInput() ||
                session.child ||
                !ended ||
                !sameProviderChild(ended, binding) ||
                !ended.rootGone ||
                ended.cause !== 'evict'
              ) {
                throw new Error('input continuation lost its provider binding')
              }
              return deps.startProviderChild(sessionId, next.clientMessageId)
            }),
            signal
          )
          if (!claim) {
            return { kind: 'ready', isCurrent }
          }
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
              binding.close && isBound()
                ? { refusal: previousExitUnverifiableRefusal() }
                : { failure: providerStartupFailureFact(error) },
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
