import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { parseWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import {
  SESSION_FIELDS_PRUNED_BY_OWNER_KEY,
  sessionFieldsRemovedWithWorkspace
} from './profile-project-session-field-disposition'
import { removeWorkspaceSessionOwners } from '../../persistence/restoring-sessions/session-owner-removal'
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
    // Borrow focus scalars together so the selected worktree retains its repo and host.
    activeRepoId: base.activeRepoId ?? incoming.activeRepoId,
    activeWorkspaceExecutionHostId:
      base.activeWorkspaceExecutionHostId ?? incoming.activeWorkspaceExecutionHostId,
    tabsByWorktree: { ...base.tabsByWorktree, ...incoming.tabsByWorktree },
    terminalLayoutsByTabId: {
      ...base.terminalLayoutsByTabId,
      ...incoming.terminalLayoutsByTabId
    },
    ...(base.localOnlyScrollbackByTabId || incoming.localOnlyScrollbackByTabId
      ? {
          localOnlyScrollbackByTabId: {
            ...base.localOnlyScrollbackByTabId,
            ...incoming.localOnlyScrollbackByTabId
          }
        }
      : {}),
    openFilesByWorktree: { ...base.openFilesByWorktree, ...incoming.openFilesByWorktree },
    markdownFrontmatterVisible: {
      ...base.markdownFrontmatterVisible,
      ...incoming.markdownFrontmatterVisible
    },
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
    ...(base.sleepingAgentSessionsByPaneKey || incoming.sleepingAgentSessionsByPaneKey
      ? {
          sleepingAgentSessionsByPaneKey: {
            ...base.sleepingAgentSessionsByPaneKey,
            ...incoming.sleepingAgentSessionsByPaneKey
          }
        }
      : {}),
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
  const base = session ?? getDefaultWorkspaceSession()
  // Workspace removal owns the per-workspace field census, including tab, pane and file entries;
  // the rules below cover keys no workspace owner names (bare repo IDs, orphaned rows).
  const ownerKeys = new Set<string>()
  for (const field of [
    'tabsByWorktree',
    'browserTabsByWorktree',
    ...sessionFieldsRemovedWithWorkspace('ownerKey')
  ] as const) {
    for (const ownerKey of Object.keys(base[field] ?? {})) {
      if (ownerKeyBelongsToRepo(ownerKey, repoId)) {
        ownerKeys.add(ownerKey)
      }
    }
  }
  const next =
    ownerKeys.size > 0 ? removeWorkspaceSessionOwners(base, ownerKeys)! : structuredClone(base)
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
