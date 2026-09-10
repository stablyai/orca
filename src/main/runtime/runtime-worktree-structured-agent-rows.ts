import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionStatusState,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

/**
 * Row sources for the structured (non-PTY) sessions a host still holds.
 *
 * A structured session reaches none of the hook or retained snapshots every other row comes from,
 * so `worktree ps` projects it from the host's status feed instead. The feed's retained
 * projections are not a roster — the caller passes only sessions the host still holds.
 */
export function structuredRuntimeWorktreeAgentSources(
  summaries: readonly AgentSessionStatusSummary[]
): RuntimeWorktreeAgentSource[] {
  const sources: RuntimeWorktreeAgentSource[] = []
  for (const summary of summaries) {
    // No turn has been persisted yet, so there is nothing to report - the same read the chat shows.
    if (!summary.status) {
      continue
    }
    const tabId = structuredAgentSessionTabId(summary.sessionId)
    // The DERIVED pane key the renderer already publishes, never the orchestration bearer handle
    // or the minted worker pane key: both of those are credentials.
    sources.push({
      paneKey: structuredAgentSessionPaneKey(tabId, summary.sessionId),
      tabId,
      worktreeId: summary.workspaceId,
      connectionId: null,
      // The shared mapping the sidebar applies, so the CLI and the GUI cannot disagree about one
      // session. No hook payload: nothing reads one off a structured row.
      state: structuredAgentSessionStatusState(summary.status),
      agentType: summary.agent,
      prompt: summary.latestPrompt,
      lastAssistantMessage: summary.lastAssistantMessage ?? null,
      toolName: summary.toolName ?? null,
      toolInput: summary.toolInput ?? null,
      interrupted: false,
      stateStartedAt: summary.updatedAt,
      updatedAt: summary.updatedAt,
      ...(summary.hostExecutionOwned ? { authority: 'structured-host' as const } : {})
    })
  }
  return sources
}
