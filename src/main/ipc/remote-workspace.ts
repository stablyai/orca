import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { Store } from '../persistence'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import { exportRemoteWorkspaceSession } from '../../shared/remote-workspace-session-projection'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot,
  RemoteWorkspaceTabObservation
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
import { remoteWorkspaceTabIntents } from './remote-workspace-tab-intent-store'
import { RemoteWorkspaceTabObservationOwnerRegistry } from './remote-workspace-tab-observation-owner'
import { getPtyProcessIncarnation } from './pty-process-incarnation-registry'

let mainWindowGetter: (() => BrowserWindow | null) | null = null
const remoteWorkspaceTabObservationOwners = new RemoteWorkspaceTabObservationOwnerRegistry()
let unregisterRemoteWorkspaceNotifications: (() => void) | null = null

function attachPtyIncarnations(
  observation: RemoteWorkspaceTabObservation
): RemoteWorkspaceTabObservation | null {
  if (!observation || !Array.isArray(observation.worktrees)) {
    return null
  }
  for (const worktree of observation.worktrees) {
    if (!worktree || !Array.isArray(worktree.tabs)) {
      return null
    }
    for (const entry of worktree.tabs) {
      const ptyIdsByLeafId = entry?.layout?.ptyIdsByLeafId
      if (
        !entry?.tab ||
        typeof entry.processIdentity !== 'string' ||
        (entry.tab.ptyId !== null && typeof entry.tab.ptyId !== 'string') ||
        (entry.layout && (typeof entry.layout !== 'object' || Array.isArray(entry.layout))) ||
        (ptyIdsByLeafId &&
          (typeof ptyIdsByLeafId !== 'object' ||
            Array.isArray(ptyIdsByLeafId) ||
            Object.values(ptyIdsByLeafId).some((ptyId) => typeof ptyId !== 'string')))
      ) {
        return null
      }
    }
  }
  return {
    ...observation,
    worktrees: observation.worktrees.map((worktree) => ({
      ...worktree,
      tabs: worktree.tabs.map((entry) => {
        const ptyIds = new Set([
          ...(entry.tab.ptyId ? [entry.tab.ptyId] : []),
          ...Object.values(entry.layout?.ptyIdsByLeafId ?? {})
        ])
        return {
          ...entry,
          processIdentity: JSON.stringify([
            entry.processIdentity,
            [...ptyIds].sort().map((ptyId) => [ptyId, getPtyProcessIncarnation(ptyId)] as const)
          ])
        }
      })
    }))
  }
}

export function _resetRemoteWorkspaceCachesForTests(): void {
  clearRemoteWorkspaceSnapshotCache()
  clearRemoteWorkspacePatchTails()
  remoteWorkspaceTabIntents.resetForTests()
  remoteWorkspaceTabObservationOwners.resetForTests()
}

export function _getRemoteWorkspaceTabIntentStateForTests(
  targetId: string
): { intents: number; overflowed: boolean } | null {
  return remoteWorkspaceTabIntents.stateForTests(targetId)
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
  const reconciled = remoteWorkspaceTabIntents.reconcile(targetId, snapshot)
  if (!reconciled) {
    return
  }
  const event: RemoteWorkspaceChangedEvent = {
    targetId,
    snapshot: reconciled,
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
  ipcMain.removeHandler('remoteWorkspace:startTabStateObservation')
  ipcMain.removeHandler('remoteWorkspace:observeTabState')
  ipcMain.removeHandler('remoteWorkspace:forgetAllTabState')
  ipcMain.removeHandler('remoteWorkspace:forgetTabState')
  ipcMain.removeHandler('remoteWorkspace:flushTabState')
  ipcMain.removeHandler('remoteWorkspace:reconcileSnapshot')

  ipcMain.handle('remoteWorkspace:get', async (_event, args: { targetId: string }) => {
    const target = getSshConnectionStore()?.getTarget(args.targetId)
    if (!target) {
      return null
    }
    const snapshot = await getRemoteSnapshot(target)
    return snapshot ? remoteWorkspaceTabIntents.reconcile(target.id, snapshot) : null
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
          const intentCapture = remoteWorkspaceTabIntents.capturePatch(target.id, session)
          const result = await queueRemoteWorkspacePatch(target.id, () =>
            patchRemoteWorkspaceSession(target, session, intentCapture)
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

  const isMainRenderer = (event: IpcMainInvokeEvent): boolean =>
    event.sender === getMainWindow()?.webContents

  ipcMain.handle('remoteWorkspace:startTabStateObservation', (event) => {
    if (!isMainRenderer(event)) {
      return 0
    }
    return remoteWorkspaceTabObservationOwners.start(event.sender, event.processId)
  })

  ipcMain.handle(
    'remoteWorkspace:observeTabState',
    (event, observation: RemoteWorkspaceTabObservation) => {
      const authority = remoteWorkspaceTabObservationOwners.resolve(
        event.sender,
        event.processId,
        observation?.rendererGeneration
      )
      if (isMainRenderer(event) && authority) {
        const attached = attachPtyIncarnations(observation)
        if (attached) {
          remoteWorkspaceTabIntents.observe(authority, attached)
        }
      }
    }
  )

  ipcMain.handle('remoteWorkspace:forgetTabState', (event, args) => {
    const input = args as { rendererGeneration?: number; targetId?: string }
    const authority = remoteWorkspaceTabObservationOwners.resolve(
      event.sender,
      event.processId,
      input.rendererGeneration
    )
    if (isMainRenderer(event) && authority && input.targetId) {
      remoteWorkspaceTabIntents.forgetTarget(input.targetId, authority)
    }
  })

  ipcMain.handle('remoteWorkspace:forgetAllTabState', (event, args) => {
    const input = args as { rendererGeneration?: number }
    const authority = remoteWorkspaceTabObservationOwners.resolve(
      event.sender,
      event.processId,
      input.rendererGeneration
    )
    if (isMainRenderer(event) && authority) {
      remoteWorkspaceTabIntents.forgetAll(authority)
    }
  })

  ipcMain.handle('remoteWorkspace:flushTabState', () => undefined)

  ipcMain.handle(
    'remoteWorkspace:reconcileSnapshot',
    (
      _event,
      args: { targetId: string; snapshot: RemoteWorkspaceSnapshot }
    ): RemoteWorkspaceSnapshot | null =>
      remoteWorkspaceTabIntents.reconcile(args.targetId, args.snapshot)
  )
}
