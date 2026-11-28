import type { TerminalTab } from '../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { worktreeWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { sessionFieldsRemovedWithWorkspace } from '../../orca-profiles/project-transfer/profile-project-session-field-disposition'
import { markdownFileIdCandidates } from '../../orca-profiles/project-transfer/profile-session-markdown-transfer'

const OWNER_KEYED_FIELDS = sessionFieldsRemovedWithWorkspace('ownerKey')
const OWNER_TAB_KEYED_FIELDS = sessionFieldsRemovedWithWorkspace('ownerTabKey')

/** IDs a removed workspace's files may use in markdownFrontmatterVisible. */
export type RemovedOwnerFileIds = Set<string>

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
  options: { advanceTerminalTopologyRevision?: boolean } = {},
  removedFileIds: RemovedOwnerFileIds = new Set()
): void {
  // Why both: unified terminal tabs can outlive their legacy row, and their layouts key by entityId.
  const ownerTabIds = new Set((next.tabsByWorktree?.[ownerKey] ?? []).map((tab) => tab.id))
  for (const tab of next.unifiedTabs?.[ownerKey] ?? []) {
    if (tab.contentType === 'terminal') {
      ownerTabIds.add(tab.entityId)
      ownerTabIds.add(tab.id)
    }
  }
  if (next.tabsByWorktree) {
    delete next.tabsByWorktree[ownerKey]
  }
  for (const tabId of ownerTabIds) {
    removedTabIds.add(tabId)
    for (const field of OWNER_TAB_KEYED_FIELDS) {
      const record = next[field] as Record<string, unknown> | undefined
      if (record) {
        delete record[tabId]
      }
    }
    if (next.activeTabId === tabId) {
      next.activeTabId = null
    }
  }
  for (const file of next.openFilesByWorktree?.[ownerKey] ?? []) {
    for (const id of markdownFileIdCandidates(file.filePath, ownerKey, file.runtimeEnvironmentId)) {
      removedFileIds.add(id)
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
  for (const field of OWNER_KEYED_FIELDS) {
    const record = next[field] as Record<string, unknown> | undefined
    if (record) {
      delete record[ownerKey]
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
