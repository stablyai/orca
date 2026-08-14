import { isDeepStrictEqual } from 'node:util'
import type { Store } from '../persistence'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { exportRemoteWorkspaceSession } from '../../shared/remote-workspace-session-projection'
import type { RemoteWorkspaceSession } from '../../shared/remote-workspace-types'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type { DirectSshAuthority } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'

type SessionAuthorityStore = Pick<Store, 'getRepo' | 'getWorkspaceSession'>

function targetForWorktree(
  store: SessionAuthorityStore,
  worktreeId: string,
  targetId: string
): string | null {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return store.getRepo(repoId, toSshExecutionHostId(targetId))?.connectionId ?? null
}

export function exportSessionForTarget(
  store: SessionAuthorityStore,
  authority: DirectSshAuthority,
  session: WorkspaceSessionState
): RemoteWorkspaceSession | null {
  const isTargetWorktree = (worktreeId: string): boolean =>
    targetForWorktree(store, worktreeId, authority.targetId) === authority.targetId
  const ownerByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree)) {
    for (const tab of tabs) {
      const owner = ownerByTabId.get(tab.id)
      if (
        owner &&
        owner !== worktreeId &&
        (isTargetWorktree(owner) || isTargetWorktree(worktreeId))
      ) {
        return null
      }
      ownerByTabId.set(tab.id, worktreeId)
    }
  }
  const ownsPty = (ptyId: string): boolean =>
    parseAppSshPtyId(ptyId)?.connectionId === authority.targetId
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree)) {
    if (!isTargetWorktree(worktreeId)) {
      continue
    }
    for (const tab of tabs) {
      if (tab.worktreeId !== worktreeId || (tab.ptyId && !ownsPty(tab.ptyId))) {
        return null
      }
      const layout = session.terminalLayoutsByTabId[tab.id]
      if (Object.values(layout?.ptyIdsByLeafId ?? {}).some((ptyId) => !ownsPty(ptyId))) {
        return null
      }
      const remoteSessionId = session.remoteSessionIdsByTabId?.[tab.id]
      if (remoteSessionId && !ownsPty(remoteSessionId)) {
        return null
      }
    }
  }
  return exportRemoteWorkspaceSession(session, { isTargetWorktree })
}

function hasWorkspaceTabs(session: WorkspaceSessionState): boolean {
  return Object.values(session.tabsByWorktree).some((tabs) => tabs.length > 0)
}

function hasRemoteWorkspaceTabs(session: RemoteWorkspaceSession): boolean {
  return Object.values(session.tabsByWorktreePath).some((tabs) => tabs.length > 0)
}

export function exportExplicitSessionForTarget(
  store: SessionAuthorityStore,
  authority: DirectSshAuthority,
  session: WorkspaceSessionState
): RemoteWorkspaceSession | null {
  const projected = exportSessionForTarget(store, authority, session)
  if (!projected) {
    return null
  }
  if (hasWorkspaceTabs(session) && !hasRemoteWorkspaceTabs(projected)) {
    return null
  }
  const durableSessions = [
    store.getWorkspaceSession(),
    store.getWorkspaceSession(toSshExecutionHostId(authority.targetId))
  ]
  for (const durableSession of durableSessions) {
    const durableProjection = exportSessionForTarget(store, authority, durableSession)
    if (!durableProjection) {
      return null
    }
    if (
      hasRemoteWorkspaceTabs(durableProjection) &&
      !isDeepStrictEqual(durableProjection, projected)
    ) {
      return null
    }
  }
  return projected
}
