import type {
  AgentConversationRow,
  AgentListResult
} from '../../../shared/agent-conversations/agent-conversation-contracts'
import type {
  AgentStatusOrchestrationContext,
  AgentStatusState
} from '../../../shared/agent-status/contracts/agent-status-types'
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsResult
} from '../../../shared/worktree/catalog/runtime-worktree-contracts'
import { structuredAgentSessionIdFromTabId } from '../../../shared/agent-session/view/structured-agent-session-tab-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/agent-session/view/structured-agent-session-projection'
import { resolveLineageRunningSession } from '../orchestration/addressing/session-lineage/structured-session-lineage'
import { agentHookServer } from '../../agent-hooks/server/agent-hook-server'
import type { ResolvedAgentConversation } from './agent-conversation-address'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { connectionEvidenceHostId } from '../workspaces/process-listing/runtime-worktree-summary-paths'
import { runtimeWorktreeAgentRowNames } from '../workspaces/process-listing/runtime-worktree-agent-rows'
import type { RuntimeOrchestrationSenderNames } from '../orchestration/mailbox/senders/runtime-orchestration-sender-names'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'

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
        ...(worktree.repo && worktree.workspaceKind !== 'folder-workspace'
          ? { repo: worktree.repo }
          : {}),
        ...(worktree.hostId ? { hostId: worktree.hostId } : {}),
        paneKey: row.paneKey,
        title: agentConversationTitle(row),
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

/** A listed agent's title: its conversation's name, else its orchestration names. */
function agentConversationTitle(
  names: Pick<RuntimeWorktreeAgentRow, 'taskTitle' | 'displayName'> & {
    conversationName?: string | null
  }
): string | null {
  return names.conversationName ?? names.displayName ?? names.taskTitle
}

/** Where one resolved conversation is open now, from its own keyed status rows: never a listing
 *  of every workspace. A closed chat or a terminal agent with no live pane has none. */
export async function agentConversationPlaces(
  runtime: {
    getWorkspaceLabel(
      worktreeId: string,
      hostId: ExecutionHostId
    ): { workspace: string; repo?: string } | null
    orchestrationSenderNames: Pick<RuntimeOrchestrationSenderNames, 'agentRowNamer'>
    getAgentStatusOrchestrationContextForPaneKey(
      paneKey: string
    ): AgentStatusOrchestrationContext | undefined
    getTerminalPtyIdForHandle(handle: string): string | null
  },
  resolved: ResolvedAgentConversation
): Promise<AgentConversationRow[]> {
  const { orcaSessionId } = resolved
  // One namer per show, as one `worktree.ps` pass names its rows.
  const name = runtime.orchestrationSenderNames.agentRowNamer()
  const tabOf = (status: { paneKey: string; tabId?: string }) =>
    status.tabId ?? parsePaneKey(status.paneKey)?.tabId
  return (await agentConversationStatuses(resolved)).map(({ worktreeId, ...status }) => {
    // The place's own host, from the row's connection evidence, so a same-id workspace on
    // another host never lends its name.
    const hostId = connectionEvidenceHostId(status.connectionId)
    const orchestration = runtime.getAgentStatusOrchestrationContextForPaneKey(status.paneKey)
    const parent = orchestration?.parentPaneKey
      ? agentHookServer.getPublicStatusSnapshotForPane(orchestration.parentPaneKey)[0]
      : undefined
    const title = agentConversationTitle(
      runtimeWorktreeAgentRowNames(
        {
          paneKey: status.paneKey,
          tabId: tabOf(status),
          worktreeId,
          ptyId: status.terminalHandle
            ? (runtime.getTerminalPtyIdForHandle(status.terminalHandle) ?? undefined)
            : undefined,
          agentType: status.agentType ?? null,
          providerSessionId: status.providerSession?.id
        },
        orchestration,
        parent && { tabId: tabOf(parent) },
        name
      )
    )
    return {
      orcaSessionId,
      kind: resolved.kind,
      agent: status.agentType ?? null,
      state: status.state,
      worktreeId,
      ...(runtime.getWorkspaceLabel(worktreeId, hostId) ?? { workspace: worktreeId }),
      hostId,
      paneKey: status.paneKey,
      title,
      lastAssistantMessage: status.lastAssistantMessage ?? null,
      updatedAt: status.evidenceObservedAt ?? status.receivedAt
    }
  })
}

/** The conversation's own status rows, one per place it is open now: none when it isn't open. */
async function agentConversationStatuses(resolved: ResolvedAgentConversation) {
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
    paneKeys = ((await agentHookServer.terminalAgentPlaces(resolved.orcaSessionId)) ?? []).map(
      (place) => place.paneKey
    )
  }
  return paneKeys.flatMap((paneKey) =>
    agentHookServer.getPublicStatusSnapshotForPane(paneKey).flatMap((status) => {
      const { worktreeId } = status
      const ours =
        resolved.kind === 'chat'
          ? status.structuredHost !== undefined
          : status.orcaSessionId === resolved.orcaSessionId
      return worktreeId && ours ? [{ ...status, worktreeId }] : []
    })
  )
}
