// `agentSession.regenerateName` — the user asks the host to name a chat again after naming failed.
// It answers once the run is accepted; the status feed carries the new name or the new failure.

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
