import {
  AGENT_CONVERSATION_REFUSAL_CODES as CODES,
  type AgentSendResult
} from '../../../shared/agent-conversations/agent-conversation-contracts'
import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { SendBody } from '../../../shared/rpc-contract/structured-agent-session/structured-agent-session-message-params'
import type { RpcContext } from '../rpc/core'
import {
  requireInstalledStructuredHost,
  requireStructuredAgentAudience
} from '../rpc/methods/structured-sessions/creation/structured-agent-session-gate'
import { sendStructuredAgentSessionForClient } from '../rpc/methods/structured-sessions/conversation/structured-agent-session-send-compatibility'
import { resolveLineageRunningSession } from '../orchestration/addressing/session-lineage/structured-session-lineage'
import type { ResolvedAgentConversation } from './agent-conversation-address'
import { AgentConversationRefusal } from './agent-conversation-refusal'

/** `orca agent send`: the chat gets the text as a message typed in its composer, not as agent
 *  mail. The client send path stamps who typed it (the orca CLI reads as an agent). */
export async function sendAgentConversation(
  ctx: RpcContext,
  resolved: ResolvedAgentConversation,
  request: { text: string; operationId: string }
): Promise<AgentSendResult> {
  const { orcaSessionId } = resolved
  if (resolved.kind !== 'chat') {
    throw new AgentConversationRefusal(
      CODES.notChat,
      `Agent ${orcaSessionId} runs in a terminal; \`orca agent send\` reaches chats only. Message it with \`orca orchestration send\`, by the handle \`orca agent show\` gives.`
    )
  }
  const { record, store } = resolved
  requireStructuredAgentAudience(ctx, record.provider)
  // The session that continues the conversation now: after /clear, its current chat.
  const running = resolveLineageRunningSession(store, record.sessionId)
  if (running.kind === 'other-host') {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Agent ${orcaSessionId} runs on another host. Send to it there, or add \`--environment <host>\`.`
    )
  }
  if (running.kind === 'unverifiable') {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Orca can't verify agent ${orcaSessionId}'s current conversation after /clear. Open the agent in Orca and try again.`
    )
  }
  const { sessionId } = running
  const host = await requireInstalledStructuredHost(ctx, sessionId)
  const conversation = host.deps.store.getConversation(sessionId)
  if (!conversation) {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Agent ${orcaSessionId} is opening or closing right now. Try again in a moment.`
    )
  }
  const body = SendBody.safeParse(structuredAgentSessionSendBody(request.text, []))
  if (!body.success) {
    throw new AgentConversationRefusal(CODES.sendRefused, 'That message is too large to send.')
  }
  const sent = await sendStructuredAgentSessionForClient(
    structuredAgentSessionMessageSendMutation({
      sessionId,
      clientOperationId: request.operationId,
      expectedRuntimeFence: conversation.currentFence,
      body: body.data
    }),
    ctx
  )
  if (!sent.ok) {
    throw new AgentConversationRefusal(
      CODES.sendRefused,
      `Agent ${orcaSessionId} didn't take the message: ${sent.refusal.message}`
    )
  }
  return { orcaSessionId, clientMessageId: sent.value.clientMessageId }
}
