import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import { exportRemoteWorkspaceSession } from '../../shared/remote-workspace-session-projection'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSession
} from '../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { getRemoteWorkspaceNamespace } from './remote-workspace-namespace'
import { registerRemoteWorkspaceNotificationHandler } from './remote-workspace-events'
import { CLIENT_ID } from './remote-workspace-client-identity'
import { listRemoteWorkspaceConnectedClients } from './remote-workspace-connected-clients'
import {
  clearRemoteWorkspacePatchTails,
  getRemoteWorkspacePatchTailCount,
  queueRemoteWorkspacePatch
} from './remote-workspace-patch-queue'
import { getRemoteSnapshot, patchRemoteWorkspaceSession } from './remote-workspace-relay-sync'
import {
  clearRemoteWorkspaceSnapshotCache,
  getRemoteWorkspaceSnapshotCacheSize,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'
import { normalizeSnapshot } from './remote-workspace-snapshot-normalization'

let mainWindowGetter: (() => BrowserWindow | null) | null = null
let unregisterRemoteWorkspaceNotifications: (() => void) | null = null

export function _resetRemoteWorkspaceCachesForTests(): void {
  clearRemoteWorkspaceSnapshotCache()
  clearRemoteWorkspacePatchTails()
}

export function _getRemoteWorkspaceCacheSizesForTests(): {
  snapshots: number
  patchTails: number
} {
  return {
    snapshots: getRemoteWorkspaceSnapshotCacheSize(),
    patchTails: getRemoteWorkspacePatchTailCount()
  }
}

function getExplicitHydratedTargetIds(value: unknown): Set<string> | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((targetId) => typeof targetId !== 'string' || targetId.length === 0)
  ) {
    return null
  }
  return new Set(value)
}

function targetForWorktree(store: Store, worktreeId: string): string | null {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return store.getRepo(repoId)?.connectionId ?? null
}

function exportSessionForTarget(
  store: Store,
  targetId: string,
  session: WorkspaceSessionState
): RemoteWorkspaceSession {
  return exportRemoteWorkspaceSession(session, {
    isTargetWorktree: (worktreeId) => targetForWorktree(store, worktreeId) === targetId
  })
}

export function handleRemoteWorkspaceNotification(
  targetId: string,
  method: string,
  params: Record<string, unknown>
): void {
  if (method !== 'workspace.changed') {
    return
  }
  const target = getSshConnectionStore()?.getTarget(targetId)
  if (!target) {
    return
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  const snapshot = normalizeSnapshot(params.snapshot, namespace)
  rememberRemoteWorkspaceSnapshot(targetId, snapshot)
  const event: RemoteWorkspaceChangedEvent = {
    targetId,
    snapshot,
    sourceClientId: typeof params.sourceClientId === 'string' ? params.sourceClientId : undefined
  }
  const win = mainWindowGetter?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('remoteWorkspace:changed', event)
  }
}

export function registerRemoteWorkspaceHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null
): void {
  mainWindowGetter = getMainWindow
  unregisterRemoteWorkspaceNotifications?.()
  unregisterRemoteWorkspaceNotifications = registerRemoteWorkspaceNotificationHandler(
    handleRemoteWorkspaceNotification
  )
  ipcMain.removeHandler('remoteWorkspace:get')
  ipcMain.removeHandler('remoteWorkspace:setForConnectedTargets')
  ipcMain.removeHandler('remoteWorkspace:listEnabledConnectedTargets')
  ipcMain.removeHandler('remoteWorkspace:listConnectedClients')
  ipcMain.removeHandler('remoteWorkspace:clientId')

  ipcMain.handle('remoteWorkspace:get', async (_event, args: { targetId: string }) => {
    const target = getSshConnectionStore()?.getTarget(args.targetId)
    if (!target) {
      return null
    }
    return getRemoteSnapshot(target)
  })

  ipcMain.handle(
    'remoteWorkspace:setForConnectedTargets',
    async (_event, args: { session?: WorkspaceSessionState; hydratedTargetIds?: unknown }) => {
      const hydratedTargetIds = getExplicitHydratedTargetIds(args.hydratedTargetIds)
      if (!hydratedTargetIds) {
        // Why: an omitted hydration set used to broadcast one session to every
        // SSH target, overwriting unrelated remote workspace snapshots.
        return []
      }
      const targets =
        getSshConnectionStore()
          ?.listTargets()
          .filter(
            (target) => hydratedTargetIds.has(target.id) && getActiveMultiplexer(target.id)
          ) ?? []

      const workspaceSession = args.session ?? store.getWorkspaceSession()
      const results = await Promise.all(
        targets.map(async (target) => {
          // Why: each target has its own revision stream. Keep same-target
          // writes queued, but do not let one slow relay block others.
          const session = exportSessionForTarget(store, target.id, workspaceSession)
          const result = await queueRemoteWorkspacePatch(target.id, () =>
            patchRemoteWorkspaceSession(target, session)
          )
          return result ? { targetId: target.id, result } : null
        })
      )
      return results.filter(
        (entry): entry is { targetId: string; result: RemoteWorkspacePatchResult } => entry !== null
      )
    }
  )

  ipcMain.handle(
    'remoteWorkspace:listEnabledConnectedTargets',
    async () =>
      getSshConnectionStore()
        ?.listTargets()
        .filter((target) => getActiveMultiplexer(target.id))
        .map((target) => target.id) ?? []
  )

  ipcMain.handle(
    'remoteWorkspace:listConnectedClients',
    async (_event, args?: { targetIds?: string[] }) => listRemoteWorkspaceConnectedClients(args)
  )

  ipcMain.handle('remoteWorkspace:clientId', () => CLIENT_ID)
}
