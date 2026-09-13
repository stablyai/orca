import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
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
  repoLookup: ReturnType<typeof createRepoRowExecutionHostLookup<Repo>>,
  worktreeId: string,
  executionHostId?: string
): string | null {
  // Why: this decides which SSH target a workspace session is exported to. The old fallback read
  // `getRepo(id)?.connectionId`, which is host-blind — the same repo id can name rows on several
  // hosts, so a session could be published to a machine that never owned the worktree (#11163).
  // Unresolvable ownership exports to nobody rather than guessing.
  const resolution = resolveWorktreeExecutionHost(repoLookup, {
    repoId: getRepoIdFromWorktreeId(worktreeId),
    hostId: executionHostId ?? null
  })
  return resolution.kind === 'resolved' ? resolution.connectionId : null
}

/**
 * Resolve each worktree's owning connection at most once for a whole publish.
 *
 * Why this is shared and not per target: `targetForWorktree` computes a connection id from the
 * repo catalog alone — only the final `=== targetId` differs — so exporting to N targets used to
 * repeat the identical resolution N times over every worktree key. `store.getRepos()` also
 * re-hydrates every repo row on each call, and the projection asks this question once per key of
 * `tabsByWorktree`, `activeTabIdByWorktree`, `lastVisitedAtByWorktreeId` and
 * `defaultTerminalTabsAppliedByWorktreeId`.
 */
function createWorktreeTargetResolver(
  repoLookup: ReturnType<typeof createRepoRowExecutionHostLookup<Repo>>
): (worktreeId: string, executionHostId?: string) => string | null {
  const resolved = new Map<string, string | null>()
  return (worktreeId, executionHostId) => {
    // Host id participates in resolution, so it has to participate in the key. NUL cannot appear
    // in either id, so it is a collision-free separator.
    const key = `${worktreeId}\u0000${executionHostId ?? ''}`
    const cached = resolved.get(key)
    if (cached !== undefined) {
      return cached
    }
    const connectionId = targetForWorktree(repoLookup, worktreeId, executionHostId)
    resolved.set(key, connectionId)
    return connectionId
  }
}

function exportSessionForTarget(
  resolveWorktreeTarget: (worktreeId: string, executionHostId?: string) => string | null,
  targetId: string,
  session: WorkspaceSessionState
): RemoteWorkspaceSession {
  return exportRemoteWorkspaceSession(session, {
    isTargetWorktree: (worktreeId, executionHostId) =>
      resolveWorktreeTarget(worktreeId, executionHostId) === targetId
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

      if (targets.length === 0) {
        // Nothing to project onto, so skip the session and repo-catalog reads entirely.
        return []
      }

      const workspaceSession = args.session ?? store.getWorkspaceSession()
      // One repo read, and ownership resolutions shared across targets: neither depends on the target.
      const resolveWorktreeTarget = createWorktreeTargetResolver(
        createRepoRowExecutionHostLookup(store.getRepos())
      )
      const results = await Promise.all(
        targets.map(async (target) => {
          // Why: each target has its own revision stream. Keep same-target
          // writes queued, but do not let one slow relay block others.
          const session = exportSessionForTarget(resolveWorktreeTarget, target.id, workspaceSession)
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
