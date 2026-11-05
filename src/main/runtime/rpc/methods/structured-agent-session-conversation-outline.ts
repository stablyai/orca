// Negotiate conversation-outline.v1 for the thread's full user-message map; failures fall back to the rail's loaded messages.

import { readAgentSessionConversationOutline } from '../../../native-chat/agent-session-wire/agent-session-conversation-outline'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'
import { OptionsParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_CONVERSATION_OUTLINE_METHODS = [
  defineMethod({
    name: 'agentSession.conversationOutline',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) =>
      readAgentSessionConversationOutline(
        await (
          await requireInstalledStructuredHost(ctx, params.sessionId)
        ).journalSnapshot(params.sessionId)
      )
  })
]
