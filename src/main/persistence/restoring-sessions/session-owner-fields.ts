import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { SESSION_FIELDS_PRUNED_BY_OWNER_KEY } from '../../orca-profiles/profile-project-session-field-disposition'

// Repo-keyed topology revisions advance rather than delete; host-qualified recency keys need a scan.
export const OWNER_KEYED_SESSION_FIELDS_DELETED_WITH_THEIR_OWNER =
  SESSION_FIELDS_PRUNED_BY_OWNER_KEY.filter(
    (field) => field !== 'terminalTopologyRevisionByRepoId' && field !== 'lastVisitedAtByWorktreeId'
  )

export function createMinimalPersistedTerminalTab(args: {
  worktreeId: string
  tabId: string
  ptyId: string
  existingTabCount: number
  startupCwd?: string
}): TerminalTab {
  const ordinal = args.existingTabCount + 1
  const defaultTitle = `Terminal ${ordinal}`
  return {
    id: args.tabId,
    ptyId: args.ptyId,
    worktreeId: args.worktreeId,
    title: defaultTitle,
    defaultTitle,
    customTitle: null,
    color: null,
    sortOrder: args.existingTabCount,
    createdAt: Date.now(),
    ...(args.startupCwd ? { startupCwd: args.startupCwd } : {})
  }
}

export function cloneWorkspaceSessionState(session: WorkspaceSessionState): WorkspaceSessionState {
  return structuredClone(session)
}

// Keep owner-indexed deletion separate so batch pruning scans pane-keyed collections only once.
export function deleteOwnerKeyedSessionFields(
  next: WorkspaceSessionState,
  ownerKey: string,
  removedTabIds: Set<string>,
  options: { advanceTerminalTopologyRevision?: boolean } = {}
): void {
  const removedTerminalTabs = next.tabsByWorktree?.[ownerKey] ?? []
  if (next.tabsByWorktree) {
    delete next.tabsByWorktree[ownerKey]
  }
  for (const tab of removedTerminalTabs) {
    removedTabIds.add(tab.id)
    delete next.terminalLayoutsByTabId[tab.id]
    if (next.activeTabId === tab.id) {
      next.activeTabId = null
    }
  }
  if (options.advanceTerminalTopologyRevision) {
    const repoId = getRepoIdFromWorktreeId(ownerKey)
    const previousTopologyRevision = next.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
    next.terminalTopologyRevisionByRepoId = {
      ...next.terminalTopologyRevisionByRepoId,
      [repoId]: previousTopologyRevision + 1
    }
  }
  const browserWorkspaces = next.browserTabsByWorktree?.[ownerKey] ?? []
  if (next.browserTabsByWorktree) {
    delete next.browserTabsByWorktree[ownerKey]
  }
  if (next.browserPagesByWorkspace) {
    for (const workspace of browserWorkspaces) {
      delete next.browserPagesByWorkspace[workspace.id]
    }
  }
  // Share the removal census so new fields cannot be pruned on only one path.
  for (const field of OWNER_KEYED_SESSION_FIELDS_DELETED_WITH_THEIR_OWNER) {
    const record = next[field] as Record<string, unknown> | undefined
    if (record) {
      delete record[ownerKey]
    }
  }
  // Include host-qualified executionHostId|worktreeId keys.
  if (next.lastVisitedAtByWorktreeId) {
    for (const key of Object.keys(next.lastVisitedAtByWorktreeId)) {
      const rawId = isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
      if (key === ownerKey || rawId === ownerKey) {
        delete next.lastVisitedAtByWorktreeId[key]
      }
    }
  }
  // Worktree owners are raw ids, but the active key stores their canonical worktree: form.
  if (
    next.activeWorkspaceKey === ownerKey ||
    next.activeWorkspaceKey === worktreeWorkspaceKey(ownerKey)
  ) {
    next.activeWorkspaceKey = null
  }
  if (next.activeWorktreeId === ownerKey) {
    next.activeWorktreeId = null
  }
}
