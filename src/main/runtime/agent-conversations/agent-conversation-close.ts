import type { AgentCloseResult } from '../../../shared/agent-conversations/agent-conversation-contracts'
import { structuredAgentSessionIdFromTabId } from '../../../shared/agent-session/view/structured-agent-session-tab-id'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { RpcContext } from '../rpc/core'
import { withTerminalCloseAttribution } from '../rpc/terminal/terminal-close-attribution'
import { closeStructuredAgentSession } from '../rpc/methods/structured-sessions/conversation/structured-agent-session-close-method'
import type { ResolvedAgentConversation } from './agent-conversation-address'
import { agentConversationPlaces, agentConversationStatuses } from './agent-conversation-list'

/** Closes every open tab of one conversation. A conversation that is not open closes nothing. */
export async function closeAgentConversation(
  ctx: RpcContext,
  resolved: ResolvedAgentConversation
): Promise<AgentCloseResult> {
  const statuses = await agentConversationStatuses(resolved)
  const places = await agentConversationPlaces(ctx.runtime, resolved)
  const closed: AgentCloseResult['closed'] = []
  const skipped: AgentCloseResult['skipped'] = []
  for (const place of places) {
    const status = statuses.find((candidate) => candidate.paneKey === place.paneKey)
    const chatSessionId =
      resolved.kind === 'chat'
        ? structuredAgentSessionIdFromTabId(parsePaneKey(place.paneKey)?.tabId ?? '')
        : null
    if (chatSessionId) {
      await closeStructuredAgentSession(ctx, chatSessionId)
      closed.push(place)
    } else if (resolved.kind === 'terminal' && status?.terminalHandle) {
      const handle = status.terminalHandle
      try {
        await withTerminalCloseAttribution('terminal.closeTab', ctx, 'terminal-tab', handle, () =>
          ctx.runtime.closeTerminalTab(handle)
        )
        closed.push(place)
      } catch (error) {
        // A terminal whose tab the app never opened has no tab to close.
        if (!(error instanceof Error && error.message.includes('terminal_handle_stale'))) {
          throw error
        }
        skipped.push(place)
      }
    } else {
      skipped.push(place)
    }
  }
  return { orcaSessionId: resolved.orcaSessionId, kind: resolved.kind, closed, skipped }
}
