import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import { LiveTextShownParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-subscribe-params'
import { structuredAgentSessionSubscriptionBase } from './structured-agent-session-subscription-id'

/** A live-text viewer says it is shown or hidden; its streams of the chat on this connection follow. */
export const STRUCTURED_AGENT_SESSION_LIVE_TEXT_SHOWN_METHOD = defineMethod({
  name: 'agentSession.liveTextShown',
  permission: 'workspace',
  params: LiveTextShownParams,
  handler: async (params, ctx) => {
    const host = await requireInstalledStructuredHost(ctx, params.sessionId)
    const viewer = structuredAgentSessionSubscriptionBase(ctx, params.sessionId)
    host.setLiveTextShown(params.sessionId, viewer, params.shown)
    return { ok: true as const }
  }
})
