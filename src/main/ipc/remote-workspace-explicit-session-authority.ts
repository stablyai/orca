import { isDeepStrictEqual } from 'node:util'
import type { Store } from '../persistence'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { exportRemoteWorkspaceSession } from '../../shared/remote-workspace-session-projection'
import type { RemoteWorkspaceSession } from '../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../shared/types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'

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
  targetId: string,
  session: WorkspaceSessionState
): RemoteWorkspaceSession {
  return exportRemoteWorkspaceSession(session, {
    isTargetWorktree: (worktreeId) => targetForWorktree(store, worktreeId, targetId) === targetId
  })
}

function hasWorkspaceTabs(session: WorkspaceSessionState): boolean {
  return Object.values(session.tabsByWorktree).some((tabs) => tabs.length > 0)
}

function hasRemoteWorkspaceTabs(session: RemoteWorkspaceSession): boolean {
  return Object.values(session.tabsByWorktreePath).some((tabs) => tabs.length > 0)
}

export function exportExplicitSessionForTarget(
  store: SessionAuthorityStore,
  targetId: string,
  session: WorkspaceSessionState
): RemoteWorkspaceSession | null {
  const projected = exportSessionForTarget(store, targetId, session)
  if (hasWorkspaceTabs(session) && !hasRemoteWorkspaceTabs(projected)) {
    return null
  }
  const durableSessions = [
    store.getWorkspaceSession(),
    store.getWorkspaceSession(toSshExecutionHostId(targetId))
  ]
  for (const durableSession of durableSessions) {
    const durableProjection = exportSessionForTarget(store, targetId, durableSession)
    if (
      hasRemoteWorkspaceTabs(durableProjection) &&
      !isDeepStrictEqual(durableProjection, projected)
    ) {
      return null
    }
  }
  return projected
}
