import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../shared/workspace-statuses'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import type { RuntimeStore } from './runtime-store-contract'

export const FLOATING_WORKTREE_DISPLAY_NAME = 'Floating Workspace'
export const FLOATING_WORKTREE_REPO_LABEL = 'Floating'

/**
 * Seeds a synthetic `global-floating-terminal` summary before PTY/session/hook attachment
 * so floating terminals and floating agents (including their subagents) surface in `worktree.ps`.
 * Call `pruneIdleFloatingWorktreePsSummary` afterwards so idle hosts without floating activity stay clean.
 */
export function seedFloatingWorktreePsSummary(
  summaries: Map<string, RuntimeWorktreePsSummary>,
  store: RuntimeStore | null
): void {
  if (summaries.has(FLOATING_TERMINAL_WORKTREE_ID)) {
    return
  }
  const meta =
    store?.getWorktreeMeta?.(FLOATING_TERMINAL_WORKTREE_ID) ??
    store?.getAllWorktreeMeta?.()[FLOATING_TERMINAL_WORKTREE_ID]
  const floatingCwd = store?.getSettings?.()?.floatingTerminalCwd?.trim() ?? ''
  summaries.set(FLOATING_TERMINAL_WORKTREE_ID, {
    workspaceKind: 'floating',
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    repoId: FLOATING_TERMINAL_WORKTREE_ID,
    hostId: LOCAL_EXECUTION_HOST_ID,
    terminalPlatform: process.platform,
    repo: FLOATING_WORKTREE_REPO_LABEL,
    path: floatingCwd,
    branch: '',
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: FLOATING_WORKTREE_DISPLAY_NAME,
    workspaceStatus: meta?.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
    sortOrder: meta?.sortOrder ?? 0,
    ...(meta?.manualOrder !== undefined ? { manualOrder: meta.manualOrder } : {}),
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    linkedItems: [],
    comment: meta?.comment ?? '',
    isPinned: false,
    isActive: false,
    unread: meta?.isUnread ?? false,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unverifiableTerminalCount: 0,
    lastOutputAt: null,
    preview: '',
    status: 'inactive',
    agents: []
  })
}

export function pruneIdleFloatingWorktreePsSummary(
  summaries: Map<string, RuntimeWorktreePsSummary>
): void {
  const floating = summaries.get(FLOATING_TERMINAL_WORKTREE_ID)
  if (!floating) {
    return
  }
  const hasActivity =
    floating.liveTerminalCount > 0 ||
    (floating.unverifiableTerminalCount ?? 0) > 0 ||
    floating.agents.length > 0 ||
    floating.hasAttachedPty
  if (!hasActivity) {
    summaries.delete(FLOATING_TERMINAL_WORKTREE_ID)
  }
}
