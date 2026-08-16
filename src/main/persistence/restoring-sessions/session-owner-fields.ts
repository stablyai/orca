import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

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
    ...(args.startupCwd ? { startupCwd: args.startupCwd } : {}),
    pendingActivationSpawn: true
  }
}

export function cloneWorkspaceSessionState(session: WorkspaceSessionState): WorkspaceSessionState {
  return structuredClone(session)
}

// Owner-keyed deletes only; pane-key-scanned collections live in deleteScannedSessionFieldsForOwners so a batch prune scans each once.
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
  if (next.openFilesByWorktree) {
    delete next.openFilesByWorktree[ownerKey]
  }
  if (next.activeFileIdByWorktree) {
    delete next.activeFileIdByWorktree[ownerKey]
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
  if (next.activeBrowserTabIdByWorktree) {
    delete next.activeBrowserTabIdByWorktree[ownerKey]
  }
  if (next.activeTabTypeByWorktree) {
    delete next.activeTabTypeByWorktree[ownerKey]
  }
  if (next.activeTabIdByWorktree) {
    delete next.activeTabIdByWorktree[ownerKey]
  }
  if (next.unifiedTabs) {
    delete next.unifiedTabs[ownerKey]
  }
  if (next.tabGroups) {
    delete next.tabGroups[ownerKey]
  }
  if (next.tabGroupLayouts) {
    delete next.tabGroupLayouts[ownerKey]
  }
  if (next.activeGroupIdByWorktree) {
    delete next.activeGroupIdByWorktree[ownerKey]
  }
  if (next.lastVisitedAtByWorktreeId) {
    delete next.lastVisitedAtByWorktreeId[ownerKey]
  }
  if (next.defaultTerminalTabsAppliedByWorktreeId) {
    delete next.defaultTerminalTabsAppliedByWorktreeId[ownerKey]
  }
  if (next.activeWorkspaceKey === ownerKey) {
    next.activeWorkspaceKey = null
  }
  if (next.activeWorktreeId === ownerKey) {
    next.activeWorktreeId = null
  }
}
