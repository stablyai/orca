// `agentSession.rename` — the user names a chat. The host saves it as the chat's one name, the
// field Session History, tabs and phones read, and the status feed carries it to every client.

import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'
import { RenameParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_RENAME_METHODS = [
  defineMethod({
    name: 'agentSession.rename',
    permission: 'workspace',
    params: RenameParams,
    handler: async (params, ctx) => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      const result = await host.setUserConversationName(
        params.sessionId,
        params.name,
        params.legacyAlias ? 'legacy-alias' : 'rename'
      )
      if (!result) {
        throw new Error('agent_session_identity_required')
      }
      return result
    }
  })
]
