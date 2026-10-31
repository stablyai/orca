import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionCurrentContextRows } from '../../../shared/agent-session-context-clear'
import type { PluginChatServices } from '../../../shared/plugins/workers/plugin-chat-api'

/** Resolve every call afresh. A delayed summary cannot follow focus into a different chat.
 * Remote hosts are intentionally absent; their chats require a routed host implementation. */
export function pluginChatServices(getHost = getStructuredAgentSessionHost): PluginChatServices {
  function hostFor(workspaceId: string, sessionId?: string) {
    const host = getHost()
    if (!host) {
      throw new Error('Local chat host is unavailable')
    }
    if (
      sessionId &&
      !host
        .listSessionTabs()
        .some((tab) => tab.workspaceId === workspaceId && tab.sessionId === sessionId)
    ) {
      throw new Error('Chat is outside the focused workspace or is not a local chat')
    }
    return host
  }
  return {
    async list(workspaceId) {
      return hostFor(workspaceId)
        .listSessionTabs()
        .filter((tab) => tab.workspaceId === workspaceId)
        .slice(0, 100)
        .map(({ sessionId, agent }) => ({ sessionId, agent }))
    },
    async read(workspaceId, sessionId) {
      const host = hostFor(workspaceId, sessionId)
      const history = await host.history({ sessionId, direction: 'tail', limit: 1 })
      if (!history.ok || history.page.fence === undefined) {
        throw new Error('Chat history is not available for a handoff')
      }
      const fence = history.page.fence
      const snapshot = await host.journalSnapshot(sessionId)
      let latestUserMessage = ''
      const lines: string[] = []
      for (const item of agentSessionCurrentContextRows(snapshot.items).items) {
        if (item.body.kind !== 'message' || item.body.command) {
          continue
        }
        const text = item.body.blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        if (item.body.role === 'user' && !item.body.from) {
          latestUserMessage = text
        }
        lines.push(`${item.body.role}: ${text}`)
      }
      const text = lines.join('\n\n')
      return {
        cursor: snapshot.cursor,
        fence,
        transcript: text.slice(-65536),
        latestUserMessage,
        truncated: text.length > 65536
      }
    },
    async handoff(workspaceId, pluginId, params) {
      const host = hostFor(workspaceId, params.sessionId)
      const fields = {
        command: 'clear' as const,
        handoff: { context: params.context, cursor: params.cursor }
      }
      const result = await host.conversationCommand(
        { callerKey: `plugin:${pluginId}` },
        {
          ...fields,
          envelope: {
            sessionId: params.sessionId,
            clientOperationId: params.operationId,
            expectedRuntimeFence: params.fence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.conversationCommand',
              sessionId: params.sessionId,
              fields
            })
          }
        }
      )
      return result.ok
        ? { completed: true }
        : {
            completed: false,
            reason: result.refusal.message,
            retry:
              result.refusal.code === 'agent_session_operation_unknown' ||
              result.refusal.code === 'agent_session_operation_expired'
          }
    }
  }
}
