import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { SESSION_FIELDS_PRUNED_BY_OWNER_KEY } from './profile-project-session-field-disposition'
import {
  isRepoWorktreeId,
  ownerKeyBelongsToRepo,
  removeRepoWorktreeRecord
} from './profile-project-worktree-identity'

function mergeTerminalTopologyRevisions(
  base: Record<string, number> | undefined,
  incoming: Record<string, number> | undefined
): Record<string, number> {
  const merged = { ...base }
  for (const [worktreeId, revision] of Object.entries(incoming ?? {})) {
    merged[worktreeId] = Math.max(merged[worktreeId] ?? 0, revision)
  }
  return merged
}

export function mergeHostWorkspaceSessions(
  existing: Partial<Record<ExecutionHostId, WorkspaceSessionState>> | undefined,
  incoming: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
): Partial<Record<ExecutionHostId, WorkspaceSessionState>> {
  const next: Partial<Record<ExecutionHostId, WorkspaceSessionState>> = { ...existing }
  for (const [hostId, session] of Object.entries(incoming)) {
    if (!session) {
      continue
    }
    next[hostId as ExecutionHostId] = mergeWorkspaceSessions(
      next[hostId as ExecutionHostId],
      session
    )
  }
  return next
}

export function mergeWorkspaceSessions(
  existing: WorkspaceSessionState | undefined,
  incoming: WorkspaceSessionState
): WorkspaceSessionState {
  const base = existing ?? getDefaultWorkspaceSession()
  return {
    ...base,
    tabsByWorktree: { ...base.tabsByWorktree, ...incoming.tabsByWorktree },
    terminalLayoutsByTabId: {
      ...base.terminalLayoutsByTabId,
      ...incoming.terminalLayoutsByTabId
    },
    openFilesByWorktree: { ...base.openFilesByWorktree, ...incoming.openFilesByWorktree },
    browserTabsByWorktree: {
      ...base.browserTabsByWorktree,
      ...incoming.browserTabsByWorktree
    },
    browserPagesByWorkspace: {
      ...base.browserPagesByWorkspace,
      ...incoming.browserPagesByWorkspace
    },
    activeBrowserTabIdByWorktree: {
      ...base.activeBrowserTabIdByWorktree,
      ...incoming.activeBrowserTabIdByWorktree
    },
    activeFileIdByWorktree: {
      ...base.activeFileIdByWorktree,
      ...incoming.activeFileIdByWorktree
    },
    activeTabTypeByWorktree: {
      ...base.activeTabTypeByWorktree,
      ...incoming.activeTabTypeByWorktree
    },
    activeTabIdByWorktree: { ...base.activeTabIdByWorktree, ...incoming.activeTabIdByWorktree },
    unifiedTabs: { ...base.unifiedTabs, ...incoming.unifiedTabs },
    tabGroups: { ...base.tabGroups, ...incoming.tabGroups },
    tabGroupLayouts: { ...base.tabGroupLayouts, ...incoming.tabGroupLayouts },
    activeGroupIdByWorktree: {
      ...base.activeGroupIdByWorktree,
      ...incoming.activeGroupIdByWorktree
    },
    lastVisitedAtByWorktreeId: {
      ...base.lastVisitedAtByWorktreeId,
      ...incoming.lastVisitedAtByWorktreeId
    },
    defaultTerminalTabsAppliedByWorktreeId: {
      ...base.defaultTerminalTabsAppliedByWorktreeId,
      ...incoming.defaultTerminalTabsAppliedByWorktreeId
    },
    terminalPtyIncarnationsByPaneKey: {
      ...base.terminalPtyIncarnationsByPaneKey,
      ...incoming.terminalPtyIncarnationsByPaneKey
    },
    terminalTopologyRevisionByRepoId: mergeTerminalTopologyRevisions(
      base.terminalTopologyRevisionByRepoId,
      incoming.terminalTopologyRevisionByRepoId
    ),
    terminalSurfaceTombstonesByPaneKey: {
      ...base.terminalSurfaceTombstonesByPaneKey,
      ...incoming.terminalSurfaceTombstonesByPaneKey
    },
    activeWorktreeIdsOnShutdown: [
      ...(base.activeWorktreeIdsOnShutdown ?? []),
      ...(incoming.activeWorktreeIdsOnShutdown ?? [])
    ],
    activeWorktreeId: base.activeWorktreeId ?? incoming.activeWorktreeId,
    activeWorkspaceKey: base.activeWorkspaceKey ?? incoming.activeWorkspaceKey,
    activeTabId: base.activeTabId ?? incoming.activeTabId
  }
}

export function removeRepoFromHostWorkspaceSessions(
  sessions: Partial<Record<ExecutionHostId, WorkspaceSessionState>> | undefined,
  repoId: string
): Partial<Record<ExecutionHostId, WorkspaceSessionState>> {
  const next: Partial<Record<ExecutionHostId, WorkspaceSessionState>> = {}
  for (const [hostId, session] of Object.entries(sessions ?? {})) {
    next[hostId as ExecutionHostId] = removeRepoFromWorkspaceSession(session, repoId)
  }
  return next
}

export function removeRepoFromWorkspaceSession(
  session: WorkspaceSessionState | undefined,
  repoId: string
): WorkspaceSessionState {
  const next = structuredClone(session ?? getDefaultWorkspaceSession())
  const removedTerminalTabIds = new Set<string>()
  for (const [ownerKey, tabs] of Object.entries(next.tabsByWorktree)) {
    if (!ownerKeyBelongsToRepo(ownerKey, repoId)) {
      continue
    }
    tabs.forEach((tab) => removedTerminalTabIds.add(tab.id))
    delete next.tabsByWorktree[ownerKey]
  }
  for (const tabId of removedTerminalTabIds) {
    delete next.terminalLayoutsByTabId[tabId]
  }
  const removedBrowserWorkspaceIds = new Set<string>()
  for (const [ownerKey, workspaces] of Object.entries(next.browserTabsByWorktree ?? {})) {
    if (!ownerKeyBelongsToRepo(ownerKey, repoId)) {
      continue
    }
    workspaces.forEach((workspace) => removedBrowserWorkspaceIds.add(workspace.id))
    delete next.browserTabsByWorktree![ownerKey]
  }
  if (next.browserPagesByWorkspace) {
    for (const workspaceId of removedBrowserWorkspaceIds) {
      delete next.browserPagesByWorkspace[workspaceId]
    }
  }
  // Driven by the census so a field cannot be added to the session type and forgotten here.
  for (const field of SESSION_FIELDS_PRUNED_BY_OWNER_KEY) {
    const record = next[field] as Record<string, unknown> | undefined
    ;(next as Record<string, unknown>)[field] = removeRepoWorktreeRecord(record, repoId)
  }
  if (next.terminalSurfaceTombstonesByPaneKey) {
    next.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
      Object.entries(next.terminalSurfaceTombstonesByPaneKey).filter(
        ([, tombstone]) => !ownerKeyBelongsToRepo(tombstone.worktreeId, repoId)
      )
    )
  }
  if (next.terminalPtyIncarnationsByPaneKey) {
    next.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
      Object.entries(next.terminalPtyIncarnationsByPaneKey).filter(([paneKey]) => {
        const separator = paneKey.lastIndexOf(':')
        return separator < 1 || !removedTerminalTabIds.has(paneKey.slice(0, separator))
      })
    )
  }
  if (next.activeWorktreeId && isRepoWorktreeId(repoId, next.activeWorktreeId)) {
    next.activeWorktreeId = null
  }
  const activeScope = next.activeWorkspaceKey ? parseWorkspaceKey(next.activeWorkspaceKey) : null
  if (activeScope?.type === 'worktree' && isRepoWorktreeId(repoId, activeScope.worktreeId)) {
    next.activeWorkspaceKey = null
  }
  next.activeWorktreeIdsOnShutdown = next.activeWorktreeIdsOnShutdown?.filter(
    (worktreeId) => !isRepoWorktreeId(repoId, worktreeId)
  )
  return next
}
