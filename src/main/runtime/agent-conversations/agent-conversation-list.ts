import type {
  AgentConversationRow,
  AgentListResult
} from '../../../shared/agent-conversations/agent-conversation-contracts'
import type { AgentStatusState } from '../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeWorktreePsResult } from '../../../shared/runtime-worktree-contracts'
import { structuredAgentSessionIdFromTabId } from '../../../shared/agent-session/view/structured-agent-session-tab-id'

/** `worktree.ps` agent rows as one flat list of chats and terminal agents, oldest state first. */
export function projectAgentConversationList(
  ps: RuntimeWorktreePsResult,
  filter: { worktreeId?: string; state?: AgentStatusState } = {}
): AgentListResult {
  const agents: AgentConversationRow[] = []
  for (const worktree of ps.worktrees) {
    if (filter.worktreeId && worktree.worktreeId !== filter.worktreeId) {
      continue
    }
    for (const row of worktree.agents) {
      if (filter.state && row.state !== filter.state) {
        continue
      }
      agents.push({
        orcaSessionId: row.orcaSessionId ?? null,
        // A chat's pane key leads with its tab id.
        kind: structuredAgentSessionIdFromTabId(row.paneKey) === null ? 'terminal' : 'chat',
        agent: row.agentType,
        state: row.state,
        worktreeId: worktree.worktreeId,
        workspace: worktree.displayName,
        ...(worktree.hostId ? { hostId: worktree.hostId } : {}),
        paneKey: row.paneKey,
        title: row.conversationName ?? row.displayName ?? row.taskTitle,
        lastAssistantMessage: row.lastAssistantMessage,
        updatedAt: row.updatedAt
      })
    }
  }
  return {
    agents,
    truncated: ps.truncated,
    ...(ps.hostScope ? { hostScope: ps.hostScope } : {})
  }
}
