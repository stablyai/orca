// `agentSession.conversationOutline` — every user message in a structured session, for the
// message rail's map of the whole thread.
//
// Additive and negotiated: a client calls it only once the host advertises
// `agent-session.conversation-outline.v1`, and treats any failure as "no outline", which
// leaves the rail on the messages it has loaded.

import { readAgentSessionConversationOutline } from '../../../native-chat/agent-session-wire/agent-session-conversation-outline'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'
import { OptionsParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_CONVERSATION_OUTLINE_METHODS = [
  defineMethod({
    name: 'agentSession.conversationOutline',
    params: OptionsParams,
    handler: async (params, ctx) =>
      readAgentSessionConversationOutline(
        await (await requireInstalledStructuredHost(ctx)).journalSnapshot(params.sessionId)
      )
  })
]
