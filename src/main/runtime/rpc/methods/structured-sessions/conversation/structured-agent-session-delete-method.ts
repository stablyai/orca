import { defineMethod } from '../../../core'
import { OptionsParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import { deleteOrcaChat } from '../../../../../native-chat/chat-deletion/orca-chat-delete'
import { ownerOnly } from '../../bots-caller-gates'
import { requireStructuredCapability } from '../creation/structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_DELETE_METHOD = defineMethod({
  // Deletes the chat for good: its record, journal, tab and agent transcript, on this host.
  name: 'agentSession.delete',
  permission: 'workspace',
  params: OptionsParams,
  handler: async (params, ctx) => {
    requireStructuredCapability(ctx)
    ownerOnly(ctx, 'Only the owner deletes chats, in Orca.')
    return deleteOrcaChat(ctx.runtime, params.sessionId)
  }
})
