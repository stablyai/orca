import { setTimeout as delay } from 'node:timers/promises'
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
import { parseExecutionHostId } from '../../shared/execution-host'
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
type RemoteWorkspaceRefresh = {
  requestedRevision: number
  staleRetryCount: number
}
const remoteWorkspaceRefreshes = new Map<string, RemoteWorkspaceRefresh>()
const REMOTE_WORKSPACE_STALE_RETRY_DELAYS_MS = [25, 100, 250] as const

export function _resetRemoteWorkspaceCachesForTests(): void {
  clearRemoteWorkspaceSnapshotCache()
  clearRemoteWorkspacePatchTails()
  remoteWorkspaceRefreshes.clear()
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

function targetForWorktree(
  store: Store,
  worktreeId: string,
  executionHostId?: string
): string | null {
  const parsedHostId = parseExecutionHostId(executionHostId)
  if (parsedHostId?.kind === 'ssh') {
    return parsedHostId.targetId
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return store.getRepo(repoId)?.connectionId ?? null
}

function exportSessionForTarget(
  store: Store,
  targetId: string,
  session: WorkspaceSessionState
): RemoteWorkspaceSession {
  return exportRemoteWorkspaceSession(session, {
    isTargetWorktree: (worktreeId, executionHostId) =>
      targetForWorktree(store, worktreeId, executionHostId) === targetId
  })
}

function publishRemoteWorkspaceSnapshot(
  targetId: string,
  snapshot: ReturnType<typeof normalizeSnapshot>,
  sourceClientId?: string
): void {
  rememberRemoteWorkspaceSnapshot(targetId, snapshot)
  const event: RemoteWorkspaceChangedEvent = {
    targetId,
    snapshot,
    ...(sourceClientId ? { sourceClientId } : {})
  }
  const win = mainWindowGetter?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('remoteWorkspace:changed', event)
  }
}

async function refreshRemoteWorkspaceSnapshot(
  targetId: string,
  refresh: RemoteWorkspaceRefresh
): Promise<void> {
  try {
    while (remoteWorkspaceRefreshes.get(targetId) === refresh) {
      const target = getSshConnectionStore()?.getTarget(targetId)
      if (!target) {
        return
      }
      const snapshot = await getRemoteSnapshot(target, { remember: false })
      if (!snapshot || remoteWorkspaceRefreshes.get(targetId) !== refresh) {
        return
      }
      if (snapshot.revision < refresh.requestedRevision) {
        const retryDelay = REMOTE_WORKSPACE_STALE_RETRY_DELAYS_MS[refresh.staleRetryCount]
        if (retryDelay === undefined) {
          console.warn(
            `[remote-workspace] Snapshot for ${targetId} remained at revision ${snapshot.revision} below required revision ${refresh.requestedRevision} after ${refresh.staleRetryCount} retries`
          )
          return
        }
        refresh.staleRetryCount++
        await delay(retryDelay)
        continue
      }
      publishRemoteWorkspaceSnapshot(targetId, snapshot)
      return
    }
  } catch (err) {
    console.warn(
      `[remote-workspace] Failed to refresh ${targetId} after revision ${refresh.requestedRevision}: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

function reconcileRemoteWorkspaceRefreshWithSnapshot(targetId: string, revision: number): void {
  const refresh = remoteWorkspaceRefreshes.get(targetId)
  if (!refresh) {
    return
  }
  refresh.requestedRevision = Math.max(refresh.requestedRevision, revision)
  if (revision === refresh.requestedRevision) {
    remoteWorkspaceRefreshes.delete(targetId)
  }
}

function queueRemoteWorkspaceRefresh(targetId: string, revision: number): void {
  const existing = remoteWorkspaceRefreshes.get(targetId)
  if (existing) {
    if (revision > existing.requestedRevision) {
      existing.requestedRevision = revision
      existing.staleRetryCount = 0
    }
    return
  }
  const refresh: RemoteWorkspaceRefresh = {
    requestedRevision: revision,
    staleRetryCount: 0
  }
  remoteWorkspaceRefreshes.set(targetId, refresh)
  void refreshRemoteWorkspaceSnapshot(targetId, refresh).finally(() => {
    if (remoteWorkspaceRefreshes.get(targetId) === refresh) {
      remoteWorkspaceRefreshes.delete(targetId)
    }
  })
}

export function handleRemoteWorkspaceNotification(
  targetId: string,
  method: string,
  params: Record<string, unknown>
): void {
  if (method === 'workspace.refreshRequired') {
    const revision = params.revision
    const sourceClientId = params.sourceClientId
    if (
      typeof revision === 'number' &&
      Number.isSafeInteger(revision) &&
      revision >= 0 &&
      sourceClientId !== CLIENT_ID
    ) {
      queueRemoteWorkspaceRefresh(targetId, revision)
    }
    return
  }
  if (method !== 'workspace.changed') {
    return
  }
  const target = getSshConnectionStore()?.getTarget(targetId)
  if (!target) {
    return
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  const snapshot = normalizeSnapshot(params.snapshot, namespace)
  reconcileRemoteWorkspaceRefreshWithSnapshot(targetId, snapshot.revision)
  publishRemoteWorkspaceSnapshot(
    targetId,
    snapshot,
    typeof params.sourceClientId === 'string' ? params.sourceClientId : undefined
  )
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
