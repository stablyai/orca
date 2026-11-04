// Accept rename retries now; status stream reports the resulting name or failure.

import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'
import { OptionsParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_REGENERATE_NAME_METHODS = [
  defineMethod({
    name: 'agentSession.regenerateName',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      return { accepted: host.regenerateConversationName(params.sessionId) }
    }
  })
]
