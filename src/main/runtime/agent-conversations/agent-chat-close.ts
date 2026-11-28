import { AGENT_CONVERSATION_REFUSAL_CODES as CODES } from '../../../shared/agent-conversations/agent-conversation-contracts'
import type { ChatCloseResult } from '../../../shared/agent-conversations/agent-conversation-contracts'
import type { RpcContext } from '../rpc/core'
import { requireCloseStructuredHost } from '../rpc/methods/structured-sessions/creation/structured-agent-session-gate'
import { closeStructuredAgentSessionForUser } from '../rpc/methods/structured-sessions/conversation/structured-agent-session-close-method'
import { resolveLineageRunningSession } from '../orchestration/addressing/session-lineage/structured-session-lineage'
import { agentConversationPlaces } from './agent-conversation-list'
import type { ResolvedAgentConversation } from './agent-conversation-address'
import { AgentConversationRefusal } from './agent-conversation-refusal'
import { runsForBot } from '../../bots/bot-session-tabs'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** `orca chat close`: close an open chat by its Orca session ID, as its tab's close button does. */
export async function closeAgentChat(
  ctx: RpcContext,
  resolved: ResolvedAgentConversation
): Promise<ChatCloseResult> {
  const { orcaSessionId } = resolved
  if (resolved.kind !== 'chat') {
    throw new AgentConversationRefusal(
      CODES.notChat,
      `Agent ${orcaSessionId} runs in a terminal, not a chat. Close it with \`orca terminal close\`.`
    )
  }
  // A /clear root names the conversation; close the session running it now.
  const running = resolveLineageRunningSession(resolved.store, resolved.record.sessionId)
  if (running.kind === 'other-host') {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Chat ${orcaSessionId} runs on another host. Close it there, or add \`--environment <host>\`.`
    )
  }
  if (running.kind === 'unverifiable') {
    throw new AgentConversationRefusal(
      CODES.unavailable,
      `Orca can't verify chat ${orcaSessionId}'s current conversation after /clear, so it closed nothing. Close the tab in Orca instead.`
    )
  }
  // A bot keeps running its chat after the tab closes, so its status row outlives the tab.
  const tablessBotRun =
    getStructuredAgentSessionHost()?.getSessionTabId(running.sessionId) === null &&
    runsForBot(ctx.runtime.bots, running.sessionId)
  if (tablessBotRun || (await agentConversationPlaces(ctx.runtime, resolved)).length === 0) {
    throw new AgentConversationRefusal(CODES.notOpen, `Chat ${orcaSessionId} is not open.`)
  }
  await closeStructuredAgentSessionForUser(ctx.runtime, running.sessionId, () =>
    requireCloseStructuredHost(ctx)
  )
  return { orcaSessionId, sessionId: running.sessionId }
}
