import { StructuredAgentSessionProviderRetry } from './structured-agent-session-provider-retry'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import { structuredAgentSessionImmediatePermission } from './structured-agent-session-launch-permission'
import {
  StructuredAgentSessionInputNotAdmitted,
  admitStructuredAgentSessionInput
} from './structured-agent-session-input-admission'
import type { StructuredAgentSessionEventRecovery } from './structured-agent-session-event-recovery'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'

export function createProviderRetry(
  context: () => StructuredAgentSessionMutationContext,
  disposed: () => boolean,
  settleCompletion: ConstructorParameters<
    typeof StructuredAgentSessionProviderRetry
  >[0]['settleCompletion']
): StructuredAgentSessionProviderRetry {
  return new StructuredAgentSessionProviderRetry({
    disposed,
    settleCompletion,
    continueTurn: async (input) => {
      const ctx = context()
      const wait = ctx.acquireAborts.begin(input.sessionId, true)
      wait.signal.addEventListener('abort', input.onAborted, { once: true })
      try {
        return (
          (await ctx.deps.adapter.continueAfterTransientFailure?.({
            ...input,
            admitFreshInput: (enqueue, signal) =>
              admitStructuredAgentSessionInput({
                serialize: (task) => ctx.serialize(input.sessionId, task),
                validate: () => {
                  if (!input.isCurrent() || signal?.aborted || wait.signal.aborted) {
                    throw new StructuredAgentSessionInputNotAdmitted()
                  }
                },
                permission: () => {
                  const record = ctx.deps.store.getRecord(input.sessionId)
                  const mode = record && structuredAgentSessionImmediatePermission(ctx.deps, record)
                  const child = ctx.sessions.get(input.sessionId)?.child
                  // Providers with per-turn policy use their ordinary compiler's prepare/acquire result.
                  if (!mode || !child) {
                    throw new StructuredAgentSessionInputNotAdmitted()
                  }
                  const acquisition = ctx.deps.adapter.permissionModeRequiresAcquisition?.(
                    input.sessionId,
                    mode
                  )
                  if (acquisition === undefined && mode !== child.permissionMode) {
                    throw new StructuredAgentSessionInputNotAdmitted()
                  }
                  return mode
                },
                inheritRunning: () => false,
                enqueue: (...args) => {
                  const admission = enqueue(...args)
                  if (admission.kind === 'sent') {
                    input.onWritten()
                  }
                  return admission
                },
                signal: AbortSignal.any([input.signal, wait.signal, ...(signal ? [signal] : [])])
              }),
            signal: AbortSignal.any([input.signal, wait.signal])
          })) ?? { state: 'refused' }
        )
      } finally {
        wait.signal.removeEventListener('abort', input.onAborted)
        wait.end()
      }
    },
    session: (id) => context().sessions.get(id),
    fence: (id) => structuredAgentSessionConversationFence(context().deps.store, id),
    serialize: (id, task) => context().serialize(id, task),
    owesWork: (id) => {
      const ctx = context()
      const work = hostStructuredAgentSessionCurrentWork(
        { store: ctx.deps.store, sessions: ctx.sessions },
        id
      )
      return work === null || work.activeTurnId() !== null || work.owesAnySend()
    },
    publish: (id) => context().publishWorkChanged(id)
  })
}

export function retryEventHandler(
  retry: StructuredAgentSessionProviderRetry,
  context: () => StructuredAgentSessionMutationContext,
  recovery: () => StructuredAgentSessionEventRecovery
): StructuredAgentSessionEventRecovery['handle'] {
  return (event) => {
    if (
      event.type === 'ended' &&
      context().sessions.get(event.sessionId)?.child?.generation === event.acquisitionGeneration
    ) {
      retry.retire(event.sessionId)
    }
    return recovery().handle(event)
  }
}

export function retryClose(
  retry: StructuredAgentSessionProviderRetry,
  lifetime: () => StructuredAgentSessionConversationLifetime
): StructuredAgentSessionConversationLifetime['close'] {
  return (sessionId, cause, admit) => {
    if (admit) {
      return lifetime().close(sessionId, cause, () => {
        const allowed = admit()
        if (allowed) {
          retry.retire(sessionId)
        }
        return allowed
      })
    }
    retry.retire(sessionId)
    return lifetime().close(sessionId, cause)
  }
}
