// `agentSession.subscribeStatus` — every structured session's projected status on one stream.
//
// Session lists read turn state from here instead of replaying transcripts: one stream per client
// covers every session, and unlike a transcript subscription it retains none of them.

import { ensureStructuredAgentSessionHostUnlessRefused } from '../../structured-agent-session-host-refusal'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionsHeldChanged
} from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { prepareStructuredTabsIfSupported } from './structured-session-tab-restore'
import { defineStreamingMethod, type RpcContext } from '../core'
import { requireStructuredAgentAudience } from './structured-agent-session-gate'
import { structuredAgentSessionStatusSubscriptionId } from './structured-agent-session-subscription-id'
import { clientReadsStructuredSessionAgent } from './structured-agent-session-policy'

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
      requireStructuredAgentAudience(ctx, '')
      const subscriptionId = structuredAgentSessionStatusSubscriptionId(ctx)
      let dispose = (): void => {}
      let stopMetadata = (): void => {}
      let stopHost = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => {
        stopMetadata()
        stopHost()
        dispose()
      })
      if (stream.isClosed()) {
        return
      }
      const holds = ctx.runtime.workspaceSetupAgentStarts
      const metadata = (): void => {
        const host = getStructuredAgentSessionHost()
        const naming = host?.deps.conversationNaming?.activeSessionIds() ?? []
        emit({
          type: 'snapshot',
          sessions: [],
          namingActiveSessionIds: naming.filter((sessionId) => {
            const record = host?.deps.store.getConversation(sessionId)
            return record && clientReadsStructuredSessionAgent(ctx, record.provider)
          }),
          setupHeldWorkspaceIds: holds.currentWorkspaceIds()
        })
      }
      let observedHost: ReturnType<typeof getStructuredAgentSessionHost> = null
      const attachHost = (): void => {
        if (stream.isClosed()) {
          return
        }
        const host = getStructuredAgentSessionHost()
        if (host === observedHost) {
          return
        }
        observedHost = host
        dispose()
        dispose = () => {}
        if (!host) {
          return
        }
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
                        return record && clientReadsStructuredSessionAgent(ctx, record.provider)
                      })
                    }
                  : {}),
                ...(event.namingActiveSessionIds !== undefined
                  ? { setupHeldWorkspaceIds: holds.currentWorkspaceIds() }
                  : {}),
                ...(event.namingActiveSessionIds
                  ? {
                      namingActiveSessionIds: event.namingActiveSessionIds.filter((sessionId) => {
                        const record = host.deps.store.getConversation(sessionId)
                        return record && clientReadsStructuredSessionAgent(ctx, record.provider)
                      })
                    }
                  : {}),
                sessions: event.sessions.filter((session) =>
                  clientReadsStructuredSessionAgent(ctx, session.agent)
                )
              })
            } else if (
              event.type !== 'status' ||
              clientReadsStructuredSessionAgent(ctx, event.session.agent)
            ) {
              emit(event)
            }
          }
        })
        if (stream.isClosed()) {
          dispose()
        }
      }
      try {
        stopMetadata = holds.subscribe(() => {
          try {
            metadata()
          } catch {
            stream.close()
          }
        })
        metadata()
        await ensureStructuredAgentSessionHostUnlessRefused(async () => {
          await prepareStructuredTabsIfSupported(ctx)
        })
        if (stream.isClosed()) {
          return
        }
        stopHost = onStructuredAgentSessionsHeldChanged(attachHost)
        attachHost()
      } catch (error) {
        stream.close()
        throw error
      }
    }
  })
]
