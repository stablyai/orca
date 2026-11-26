// `agentSession.subscribeStatus` — every structured session's projected status on one stream.
//
// Session lists read turn state from here instead of replaying transcripts: one stream per client
// covers every session, and unlike a transcript subscription it retains none of them.

import { prepareStructuredTabsIfSupported } from '../../session-tabs/structured-session-tab-restore'
import { defineStreamingMethod, type RpcContext } from '../../../core'
import { requireStructuredHost as requireHost } from '../creation/structured-agent-session-gate'
import { structuredAgentSessionStatusSubscriptionId } from './structured-agent-session-subscription-id'
import { clientReadsStructuredSessionAgent } from '../structured-agent-session-policy'
import {
  botShareScopeOf,
  botShareSessionFilter
} from '../../../../../bots/team-share/bot-share-chats'

/** Ties a stream to both ends that can close it — the runtime's subscription registry and the
 *  transport abort — so either one runs `onClose` exactly once. */
export function bindStructuredAgentSessionStream(
  ctx: RpcContext,
  subscriptionId: string,
  onClose: () => void
): { isClosed: () => boolean; close: () => void } {
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
  return { isClosed: () => closed, close: () => releaseTransportSubscription() }
}

export const STRUCTURED_AGENT_SESSION_STATUS_METHODS = [
  defineStreamingMethod({
    name: 'agentSession.subscribeStatus',
    permission: 'workspace',
    params: null,
    handler: async (_params, ctx, emit) => {
      const restoration = prepareStructuredTabsIfSupported(ctx)
      if (restoration) {
        await restoration
      }
      const host = requireHost(ctx)
      const subscriptionId = structuredAgentSessionStatusSubscriptionId(ctx)
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      // A teammate's stream carries only their own chats on the shared bot.
      const share = botShareScopeOf(ctx)
      const listed = share ? botShareSessionFilter(ctx.runtime, share) : () => true
      dispose = host.subscribeStatus({
        id: subscriptionId,
        emit: (event) => {
          if (event.type === 'snapshot') {
            emit({
              ...event,
              ...(event.conversationNames
                ? {
                    conversationNames: event.conversationNames.filter((note) => {
                      const record = host.deps.store.getConversation(note.sessionId)
                      return (
                        record &&
                        clientReadsStructuredSessionAgent(ctx, record.provider) &&
                        listed(note.sessionId)
                      )
                    })
                  }
                : {}),
              ...(event.namingActiveSessionIds
                ? {
                    namingActiveSessionIds: event.namingActiveSessionIds.filter((sessionId) => {
                      const record = host.deps.store.getConversation(sessionId)
                      return (
                        record &&
                        clientReadsStructuredSessionAgent(ctx, record.provider) &&
                        listed(sessionId)
                      )
                    })
                  }
                : {}),
              sessions: event.sessions.filter(
                (session) =>
                  clientReadsStructuredSessionAgent(ctx, session.agent) && listed(session.sessionId)
              )
            })
          } else if (
            event.type !== 'status' ||
            (clientReadsStructuredSessionAgent(ctx, event.session.agent) &&
              listed(event.session.sessionId))
          ) {
            emit(event)
          }
        }
      })
      if (stream.isClosed()) {
        dispose()
      }
    }
  })
]
