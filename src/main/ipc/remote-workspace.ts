import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import { exportRemoteWorkspaceSession } from '../../shared/remote-workspace-session-projection'
import {
  REMOTE_WORKSPACE_CHANGED_NOTIFICATION,
  REMOTE_WORKSPACE_STALE_NOTIFICATION,
  type RemoteWorkspaceChangedEvent,
  type RemoteWorkspaceObservedPatchResult,
  type RemoteWorkspaceObservedSnapshot,
  type RemoteWorkspaceSession
} from '../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from '../../shared/worktree-execution-host-resolution'
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
  cachedRemoteWorkspaceSnapshotAuthorizesRevision,
  clearRemoteWorkspaceSnapshotCache,
  getCachedRemoteWorkspaceSnapshot,
  getRemoteWorkspaceSnapshotCacheSize,
  rememberLocallyPatchedRemoteWorkspaceSnapshot,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'
import { normalizeSnapshot } from './remote-workspace-snapshot-normalization'
import {
  _resetRemoteWorkspaceStaleResyncForTests,
  resyncStaleRemoteWorkspace
} from './remote-workspace-stale-resync'

let mainWindowGetter: (() => BrowserWindow | null) | null = null
let unregisterRemoteWorkspaceNotifications: (() => void) | null = null

export function _resetRemoteWorkspaceCachesForTests(): void {
  clearRemoteWorkspaceSnapshotCache()
  clearRemoteWorkspacePatchTails()
  _resetRemoteWorkspaceStaleResyncForTests()
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

function getExpectedTargetRevisions(
  value: unknown,
  targetIds: ReadonlySet<string>
): Map<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const revisions = new Map<string, number>()
  for (const targetId of targetIds) {
    const revision = (value as Record<string, unknown>)[targetId]
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      return null
    }
    revisions.set(targetId, revision)
  }
  return revisions
}

function getExpectedHostObservationTokens(
  value: unknown,
  targetIds: ReadonlySet<string>
): Map<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const tokens = new Map<string, string>()
  for (const targetId of targetIds) {
    const token = (value as Record<string, unknown>)[targetId]
    if (typeof token !== 'string' || token.length === 0 || token.length > 128) {
      return null
    }
    tokens.set(targetId, token)
  }
  return tokens
}

function targetForWorktree(
  store: Store,
  worktreeId: string,
  executionHostId?: string
): string | null {
  // Why: this decides which SSH target a workspace session is exported to. The old fallback read
  // `getRepo(id)?.connectionId`, which is host-blind — the same repo id can name rows on several
  // hosts, so a session could be published to a machine that never owned the worktree (#11163).
  // Unresolvable ownership exports to nobody rather than guessing.
  const resolution = resolveWorktreeExecutionHost(
    createRepoRowExecutionHostLookup(store.getRepos()),
    { repoId: getRepoIdFromWorktreeId(worktreeId), hostId: executionHostId ?? null }
  )
  return resolution.kind === 'resolved' ? resolution.connectionId : null
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

function sendRemoteWorkspaceChanged(
  targetId: string,
  snapshot: RemoteWorkspaceObservedSnapshot,
  sourceClientId: string | undefined
): void {
  const event: RemoteWorkspaceChangedEvent = {
    targetId,
    snapshot,
    ...(sourceClientId !== undefined ? { sourceClientId } : {})
  }
  const win = mainWindowGetter?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('remoteWorkspace:changed', event)
  }
}

export function handleRemoteWorkspaceNotification(
  targetId: string,
  method: string,
  params: Record<string, unknown>
): void {
  if (method === REMOTE_WORKSPACE_STALE_NOTIFICATION) {
    const target = getSshConnectionStore()?.getTarget(targetId)
    if (!target) {
      return
    }
    // No sourceClientId on the resynced event: the marker names no author, and guessing one would
    // let the renderer's own-echo filter discard another device's change.
    void resyncStaleRemoteWorkspace(target, (snapshot) =>
      sendRemoteWorkspaceChanged(targetId, snapshot, undefined)
    )
    return
  }
  if (method !== REMOTE_WORKSPACE_CHANGED_NOTIFICATION) {
    return
  }
  const target = getSshConnectionStore()?.getTarget(targetId)
  if (!target) {
    return
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  const snapshot = normalizeSnapshot(params.snapshot, namespace)
  const sourceClientId =
    typeof params.sourceClientId === 'string' ? params.sourceClientId : undefined
  const observedSnapshot =
    sourceClientId === CLIENT_ID
      ? rememberLocallyPatchedRemoteWorkspaceSnapshot(targetId, snapshot)
      : rememberRemoteWorkspaceSnapshot(targetId, snapshot)
  sendRemoteWorkspaceChanged(targetId, observedSnapshot, sourceClientId)
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
    async (
      _event,
      args: {
        session?: WorkspaceSessionState
        hydratedTargetIds?: unknown
        expectedRevisionsByTargetId?: unknown
        expectedHostObservationTokensByTargetId?: unknown
      }
    ) => {
      const hydratedTargetIds = getExplicitHydratedTargetIds(args.hydratedTargetIds)
      if (!hydratedTargetIds) {
        // Why: an omitted hydration set used to broadcast one session to every
        // SSH target, overwriting unrelated remote workspace snapshots.
        return []
      }
      const expectedRevisions = getExpectedTargetRevisions(
        args.expectedRevisionsByTargetId,
        hydratedTargetIds
      )
      if (!expectedRevisions) {
        return []
      }
      const expectedHostObservationTokens = getExpectedHostObservationTokens(
        args.expectedHostObservationTokensByTargetId,
        hydratedTargetIds
      )
      if (!expectedHostObservationTokens) {
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
          const result = await queueRemoteWorkspacePatch(target.id, async () => {
            const current =
              getCachedRemoteWorkspaceSnapshot(target.id) ?? (await getRemoteSnapshot(target))
            const expectedRevision = expectedRevisions.get(target.id)
            const expectedHostObservationToken = expectedHostObservationTokens.get(target.id)
            if (
              !current ||
              expectedRevision === undefined ||
              expectedHostObservationToken === undefined ||
              current.hostObservationToken !== expectedHostObservationToken ||
              !cachedRemoteWorkspaceSnapshotAuthorizesRevision(target.id, expectedRevision)
            ) {
              const latest = getCachedRemoteWorkspaceSnapshot(target.id) ?? current
              return latest
                ? ({ ok: false, reason: 'stale-revision', snapshot: latest } as const)
                : null
            }
            return patchRemoteWorkspaceSession(target, session)
          })
          return result ? { targetId: target.id, result } : null
        })
      )
      return results.filter(
        (entry): entry is { targetId: string; result: RemoteWorkspaceObservedPatchResult } =>
          entry !== null
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
