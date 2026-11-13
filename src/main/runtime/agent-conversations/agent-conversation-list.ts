import type {
  AgentConversationRow,
  AgentListResult
} from '../../../shared/agent-conversations/agent-conversation-contracts'
import type { AgentStatusState } from '../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeWorktreePsResult } from '../../../shared/runtime-worktree-contracts'
import { structuredAgentSessionIdFromTabId } from '../../../shared/agent-session/view/structured-agent-session-tab-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/agent-session/view/structured-agent-session-projection'
import { resolveLineageRunningSession } from '../orchestration/addressing/session-lineage/structured-session-lineage'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import type { ResolvedAgentConversation } from './agent-conversation-address'

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

/** Where one resolved conversation is open now, from its own keyed status rows: never a listing
 *  of every workspace. A closed chat or a terminal agent with no live pane has none. */
export async function agentConversationPlaces(
  runtime: { getWorkspaceDisplayName(worktreeId: string): string | null },
  resolved: ResolvedAgentConversation
): Promise<AgentConversationRow[]> {
  const { orcaSessionId } = resolved
  let paneKeys: string[]
  if (resolved.kind === 'chat') {
    // A chat's status row is keyed by the session that runs its conversation now.
    const running = resolveLineageRunningSession(resolved.store, resolved.record.sessionId)
    paneKeys =
      running.kind === 'here'
        ? [
            structuredAgentSessionPaneKey(
              structuredAgentSessionTabId(running.sessionId),
              running.sessionId
            )
          ]
        : []
  } else {
    paneKeys = ((await agentHookServer.terminalAgentPlaces(orcaSessionId)) ?? []).map(
      (place) => place.paneKey
    )
  }
  return paneKeys.flatMap((paneKey) =>
    agentHookServer.getPublicStatusSnapshotForPane(paneKey).flatMap((status) => {
      const { worktreeId } = status
      const ours =
        resolved.kind === 'chat'
          ? status.structuredHost !== undefined
          : status.orcaSessionId === orcaSessionId
      return worktreeId && ours
        ? [
            {
              orcaSessionId,
              kind: resolved.kind,
              agent: status.agentType ?? null,
              state: status.state,
              worktreeId,
              workspace: runtime.getWorkspaceDisplayName(worktreeId) ?? worktreeId,
              paneKey: status.paneKey,
              title: null,
              lastAssistantMessage: status.lastAssistantMessage ?? null,
              updatedAt: status.evidenceObservedAt ?? status.receivedAt
            }
          ]
        : []
    })
  )
}
