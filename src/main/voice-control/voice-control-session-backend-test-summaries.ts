import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type { TuiAgent } from '../../shared/tui-agent'

/**
 * The worktree-ps summary builders for the session-backend test files: one live agent
 * row ("oak") and one idle resumable worktree, with host/state/history overrides for
 * the SSH-boundary and watchdog scenarios.
 */

const LEAF = '123e4567-e89b-12d3-a456-426614174000'
export const PANE = `tab-1:${LEAF}`

export function rosterSummary(
  agentState: AgentStatusState = 'working',
  stateStartedAt?: number,
  hostId?: RuntimeWorktreePsSummary['hostId']
): RuntimeWorktreePsSummary[] {
  return [
    {
      worktreeId: 'w1',
      displayName: 'oak',
      repoId: 'r1',
      repo: 'repo',
      path: '/tmp/x',
      branch: 'main',
      ...(hostId !== undefined ? { hostId } : {}),
      isArchived: false,
      isMainWorktree: false,
      hasHostSidebarActivity: false,
      parentWorktreeId: null,
      childWorktreeIds: [],
      workspaceStatus: 'in-progress',
      sortOrder: 0,
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      comment: '',
      isPinned: false,
      isActive: false,
      unread: false,
      liveTerminalCount: 1,
      hasAttachedPty: true,
      lastOutputAt: null,
      preview: '',
      status: 'working',
      agents: [
        {
          paneKey: PANE,
          parentPaneKey: null,
          state: agentState,
          agentType: 'claude',
          prompt: '',
          taskTitle: 'Fixing login',
          displayName: null,
          lastAssistantMessage: null,
          toolName: null,
          toolInput: null,
          interrupted: false,
          // Read fresh at every getRoster() call so a watchdog tick sees the state as
          // younger than the dispatch; stale-state tests set this explicitly.
          stateStartedAt: stateStartedAt ?? Date.now(),
          updatedAt: 0
        }
      ]
    }
  ]
}

export function idleWorktreeSummary(overrides?: {
  hostId?: RuntimeWorktreePsSummary['hostId']
  /** Null omits the field entirely — the wire type has no null, only absent. */
  createdWithAgent?: TuiAgent | null
}): RuntimeWorktreePsSummary {
  return {
    ...rosterSummary()[0]!,
    worktreeId: 'w-idle',
    displayName: 'ci-type-checking-guard',
    path: '/tmp/ci-guard',
    agents: [],
    liveTerminalCount: 0,
    hasAttachedPty: false,
    ...(overrides?.hostId !== undefined ? { hostId: overrides.hostId } : {}),
    ...(overrides?.createdWithAgent === null
      ? {}
      : { createdWithAgent: overrides?.createdWithAgent ?? 'codex' })
  }
}
