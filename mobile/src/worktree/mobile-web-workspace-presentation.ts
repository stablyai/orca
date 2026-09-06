import type {
  MobileWebWorkspaceAgent,
  MobileWebWorkspaceSummary
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { Worktree } from './workspace-list-types'

export function mobileWebWorkspacePresentation(workspace: MobileWebWorkspaceSummary): Worktree {
  return {
    workspaceKind: workspace.workspaceKind,
    worktreeId: workspace.id,
    repoId: workspace.repoId,
    repo: workspace.repo,
    branch: workspace.branch,
    displayName: workspace.name,
    workspaceStatus: workspace.workspaceStatus,
    sortOrder: workspace.sortOrder,
    ...(workspace.manualOrder === null ? {} : { manualOrder: workspace.manualOrder }),
    ...(workspace.lastActivityAt === null ? {} : { lastActivityAt: workspace.lastActivityAt }),
    ...(workspace.createdAt === null ? {} : { createdAt: workspace.createdAt }),
    // Why: the page may display a basename for folder workspaces but must never receive the host path.
    path: workspace.workspaceKind === 'folder-workspace' ? workspace.folderName : '',
    isArchived: workspace.isArchived,
    isMainWorktree: workspace.isMainWorktree,
    hasHostSidebarActivity: workspace.hasHostSidebarActivity,
    parentWorktreeId: workspace.parentWorkspaceId,
    liveTerminalCount: workspace.liveTerminalCount,
    hasAttachedPty: workspace.hasAttachedPty,
    preview: '',
    unread: workspace.unread,
    ...(workspace.lastOutputAt === null ? {} : { lastOutputAt: workspace.lastOutputAt }),
    isPinned: workspace.isPinned,
    isActive: workspace.isActive,
    linkedPR: workspace.linkedPR,
    linkedIssue: workspace.linkedIssue,
    linkedLinearIssue: workspace.linkedLinearIssue,
    linkedGitLabMR: workspace.linkedGitLabMR,
    linkedGitLabIssue: workspace.linkedGitLabIssue,
    comment: workspace.comment,
    status: workspace.status,
    agents: workspace.agents.map(mobileWebAgentPresentation)
  }
}

export function mobileWebWorkspacePresentations(
  workspaces: readonly MobileWebWorkspaceSummary[]
): Worktree[] {
  return workspaces.map(mobileWebWorkspacePresentation)
}

function mobileWebAgentPresentation(agent: MobileWebWorkspaceAgent): RuntimeWorktreeAgentRow {
  return {
    paneKey: agent.id,
    parentPaneKey: agent.parentId,
    state: agent.state,
    agentType: agent.agentType,
    prompt: agent.prompt,
    taskTitle: agent.taskTitle,
    displayName: agent.displayName,
    lastAssistantMessage: agent.lastAssistantMessage,
    toolName: null,
    toolInput: null,
    interrupted: agent.interrupted,
    stateStartedAt: agent.stateStartedAt,
    updatedAt: agent.updatedAt
  }
}
