import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { SESSION_FIELDS_PRUNED_BY_OWNER_KEY } from '../../orca-profiles/profile-project-session-field-disposition'

/**
 * The census fields this path deletes by indexing the owner key.
 *
 * Two classified fields are handled separately below: the topology revision is keyed by repo
 * rather than by owner, so removing one owner advances it instead of dropping it; and the recency
 * map also holds host-qualified keys, so it is scanned rather than indexed.
 */
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
    ...(args.startupCwd ? { startupCwd: args.startupCwd } : {}),
    pendingActivationSpawn: true
  }
}

export function cloneWorkspaceSessionState(session: WorkspaceSessionState): WorkspaceSessionState {
  return structuredClone(session)
}

const WORKSPACE_SESSION_OWNER_RECORD_KEYS = [
  'tabsByWorktree',
  'openFilesByWorktree',
  'activeFileIdByWorktree',
  'browserTabsByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

export function collectWorkspaceSessionOwnerKeys(session: WorkspaceSessionState): Set<string> {
  const ownerKeys = new Set<string>()
  for (const recordKey of WORKSPACE_SESSION_OWNER_RECORD_KEYS) {
    for (const ownerKey of Object.keys(session[recordKey] ?? {})) {
      ownerKeys.add(ownerKey)
    }
  }
  if (session.activeWorkspaceKey) {
    ownerKeys.add(session.activeWorkspaceKey)
  }
  if (session.activeWorktreeId) {
    ownerKeys.add(session.activeWorktreeId)
  }
  for (const worktreeId of session.activeWorktreeIdsOnShutdown ?? []) {
    ownerKeys.add(worktreeId)
  }
  for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    ownerKeys.add(record.worktreeId)
  }
  for (const tombstone of Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})) {
    ownerKeys.add(tombstone.worktreeId)
  }
  return ownerKeys
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
    if (next.remoteSessionIdsByTabId) {
      delete next.remoteSessionIdsByTabId[tab.id]
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
  // Driven by the same census the repo-removal path uses, so a field added to the session type
  // cannot be dropped there and forgotten here -- which is how the client-hosted rows were missed.
  for (const field of OWNER_KEYED_SESSION_FIELDS_DELETED_WITH_THEIR_OWNER) {
    const record = next[field] as Record<string, unknown> | undefined
    if (record) {
      delete record[ownerKey]
    }
  }
  // Scanned, not indexed: this map also holds `${executionHostId}|${worktreeId}` keys.
  if (next.lastVisitedAtByWorktreeId) {
    for (const key of Object.keys(next.lastVisitedAtByWorktreeId)) {
      const rawId = isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
      if (key === ownerKey || rawId === ownerKey) {
        delete next.lastVisitedAtByWorktreeId[key]
      }
    }
  }
  if (next.activeWorkspaceKey === ownerKey) {
    next.activeWorkspaceKey = null
  }
  if (next.activeWorktreeId === ownerKey) {
    next.activeWorktreeId = null
  }
}
