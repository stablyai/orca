// `agentSession.subscribeStatus` — every structured session's projected status on one stream.
//
// Session lists read turn state from here instead of replaying transcripts: one stream per client
// covers every session, and unlike a transcript subscription it retains none of them.

import { defineStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'
import {
  isWorkItemStartStructuredSession,
  requireStructuredHost as requireHost,
  requireWorkItemStartStatusHost
} from './structured-agent-session-gate'
import { supportsStructuredAgentSessions } from './structured-agent-session-policy'
import { structuredAgentSessionStatusSubscriptionId } from './structured-agent-session-subscription-id'

/** Ties a stream to both ends that can close it — the runtime's subscription registry and the
 *  transport abort — so either one runs `onClose` exactly once. */
export function bindStructuredAgentSessionStream(
  ctx: RpcContext,
  subscriptionId: string,
  onClose: () => void
): { isClosed: () => boolean } {
  let closed = false
  let releaseTransportSubscription = (): void => {}
  const onTransportAbort = (): void => releaseTransportSubscription()
  const cleanup = (): void => {
    closed = true
    ctx.signal?.removeEventListener('abort', onTransportAbort)
    onClose()
  }
  let registration: { releaseIfCurrent: () => void }
  if (typeof ctx.runtime.registerOwnedSubscriptionCleanup === 'function') {
    registration = ctx.runtime.registerOwnedSubscriptionCleanup(
      subscriptionId,
      cleanup,
      ctx.connectionId
    )
  } else {
    ctx.runtime.registerSubscriptionCleanup(subscriptionId, cleanup, ctx.connectionId)
    registration = { releaseIfCurrent: () => ctx.runtime.cleanupSubscription(subscriptionId) }
  }
  releaseTransportSubscription = registration.releaseIfCurrent
  ctx.signal?.addEventListener('abort', onTransportAbort, { once: true })
  if (ctx.signal?.aborted) {
    onTransportAbort()
  }
  return { isClosed: () => closed }
}

export const STRUCTURED_AGENT_SESSION_STATUS_METHODS: RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'agentSession.subscribeStatus',
    params: null,
    handler: async (_params, ctx, emit) => {
      const globallyEnabled = supportsStructuredAgentSessions(ctx)
      const host = globallyEnabled ? requireHost(ctx) : requireWorkItemStartStatusHost(ctx)
      const subscriptionId = structuredAgentSessionStatusSubscriptionId(ctx)
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      dispose = globallyEnabled
        ? host.subscribeStatus({ id: subscriptionId, emit })
        : host.subscribeStatus({ id: subscriptionId, emit }, (sessionId) =>
            isWorkItemStartStructuredSession(host, sessionId)
          )
      if (stream.isClosed()) {
        dispose()
      }
    }
  })
]
