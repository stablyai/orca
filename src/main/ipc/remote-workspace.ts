import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import {
  REMOTE_WORKSPACE_CHANGED_NOTIFICATION,
  REMOTE_WORKSPACE_STALE_NOTIFICATION,
  type RemoteWorkspaceChangedEvent,
  type RemoteWorkspaceObservedPatchResult,
  type RemoteWorkspaceObservedSnapshot
} from '../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { createRepoRowExecutionHostLookup } from '../../shared/worktree-execution-host-resolution'
import {
  createWorktreeTargetResolver,
  exportSessionForTarget,
  persistedSessionForTarget
} from './remote-workspace-target-session-export'
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

      if (targets.length === 0) {
        // Nothing to project onto, so skip the session and repo-catalog reads entirely.
        return []
      }

      // One repo read, and ownership resolutions shared across targets: neither depends on the target.
      const resolveWorktreeTarget = createWorktreeTargetResolver(
        createRepoRowExecutionHostLookup(store.getRepos())
      )
      const results = await Promise.all(
        targets.map(async (target) => {
          // Why: each target has its own revision stream. Keep same-target
          // writes queued, but do not let one slow relay block others.
          // `persistedSessionForTarget` reads inside this map on purpose: it merges the target's
          // own `ssh:<targetId>` partition, so the result genuinely differs per target. Hoisting
          // it back out re-publishes the local half as the whole session (#12723/#12721). The only
          // repeated part is an O(1) property read, so there is nothing here worth optimising.
          const session = exportSessionForTarget(
            resolveWorktreeTarget,
            target.id,
            args.session ?? persistedSessionForTarget(store, target.id)
          )
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
