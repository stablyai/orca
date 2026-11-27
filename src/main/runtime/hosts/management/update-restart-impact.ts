import type { RemoteServerUpdateRestartImpact } from '../../../../shared/remote-runtime/host-catalog/remote-server-update'
import { structuredAgentSessionIdFromTabId } from '../../../../shared/agent-session/view/structured-agent-session-tab-id'
import { inProcessTerminalPtyIds } from '../../../ipc/pty/provider/kill-all'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { projectAgentConversationList } from '../../agent-conversations/agent-conversation-list'
import type { OrcaRuntimeService } from '../../orca-runtime'

// Same bound as agent.list: no workspace page may hide a chat the restart would stop.
const RESTART_IMPACT_WORKTREE_LIMIT = 10_000

/** Names what an update restart would stop, using quit's own keep-or-stop rule. */
export async function readUpdateRestartImpact(
  runtime: OrcaRuntimeService
): Promise<RemoteServerUpdateRestartImpact> {
  const stoppedChats = new Set(getStructuredAgentSessionHost()?.reads.agentsStoppedByQuit() ?? [])
  const inProcessPtys = new Set(inProcessTerminalPtyIds())
  // Usually nothing stops (daemon terminals and relayed chats survive), so list nothing then.
  const [chats, terminals] = await Promise.all([
    stoppedChats.size === 0
      ? []
      : runtime.getWorktreePs(RESTART_IMPACT_WORKTREE_LIMIT, true, false).then((ps) =>
          projectAgentConversationList(ps).agents.filter((row) => {
            const sessionId = row.kind === 'chat' && structuredAgentSessionIdFromTabId(row.paneKey)
            return sessionId ? stoppedChats.has(sessionId) : false
          })
        ),
    inProcessPtys.size === 0
      ? []
      : runtime
          .listTerminals(undefined, undefined, { includeVisualLayouts: false })
          .then((list) =>
            list.terminals.flatMap(({ preview: _preview, ...row }) =>
              row.ptyId && inProcessPtys.has(row.ptyId) ? [row] : []
            )
          )
  ])
  return { chats, terminals }
}
