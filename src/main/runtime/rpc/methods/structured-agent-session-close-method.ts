import { defineMethod } from '../core'
import { OptionsParams } from './structured-agent-session-schemas'
import {
  requireStructuredCapability,
  requireStructuredCleanupHost
} from './structured-agent-session-gate'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { noteStructuredAgentSessionClose } from './structured-agent-session-close-before-create'
import {
  captureStructuredSessionSurface,
  retireCapturedStructuredSessionSurface
} from '../../agent-session/structured-agent-session-close'

export const STRUCTURED_AGENT_SESSION_CLOSE_METHOD = defineMethod({
  // Close only provider/in-memory state, preserving record/journal for future attachment.
  name: 'agentSession.close',
  permission: 'workspace',
  params: OptionsParams,
  handler: async (params, ctx) => {
    requireStructuredCapability(ctx)
    // Record close before requiring host so even failed closes fence racing creates.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      noteStructuredAgentSessionClose(
        params.sessionId,
        (getStructuredAgentSessionHost()?.deps.store.getConversation(params.sessionId) ?? null) !==
          null
      )
    }
    const host = requireStructuredCleanupHost(ctx)
    const surface = captureStructuredSessionSurface(host, params.sessionId, ctx.runtime)
    try {
      const result = await retireCapturedStructuredSessionSurface(
        host,
        params.sessionId,
        surface,
        ctx.runtime
      )
      if (result.error !== undefined) {
        throw result.error
      }
    } finally {
      await host.close(params.sessionId, 'user-close')
    }
    return { ok: true as const }
  }
})
