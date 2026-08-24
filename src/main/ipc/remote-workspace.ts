import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSession
} from '../../shared/remote-workspace-types'
import type { DirectSshAuthority } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { isAdmissibleDirectSshAuthority } from '../../shared/ssh-retained-payload-admission'
import { adoptOrphanedWorkspaceSessionPartition } from '../../shared/workspace-session-partition-adoption'
import { findAmbiguousWorkspaceSessionKeys } from '../../shared/workspace-session-partition-authority'
import { getRemoteWorkspaceNamespace } from './remote-workspace-namespace'
import { registerRemoteWorkspaceNotificationHandler } from './remote-workspace-events'
import {
  exportExplicitSessionForTarget,
  exportSessionForTarget
} from './remote-workspace-explicit-session-authority'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority
} from '../ssh/ssh-provider-authority'
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

export function handleRemoteWorkspaceNotification(
  targetId: string,
  method: string,
  params: Record<string, unknown>,
  authority: DirectSshAuthority
): void {
  if (
    method !== 'workspace.changed' ||
    authority.targetId !== targetId ||
    !isCurrentSshProviderAuthority(authority)
  ) {
    return
  }
  const target = getSshConnectionStore()?.getTarget(targetId)
  if (!target) {
    return
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  const snapshot = normalizeSnapshot(params.snapshot, namespace)
  rememberRemoteWorkspaceSnapshot(authority, snapshot)
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
    return getRemoteSnapshot(target, getSshProviderAuthority(target.id))
  })

  ipcMain.handle(
    'remoteWorkspace:setForConnectedTargets',
    async (
      _event,
      args: {
        session?: WorkspaceSessionState
        sessionTargetId?: unknown
        sessionAuthority?: unknown
        hydratedTargetIds?: unknown
      }
    ) => {
      const hydratedTargetIds = getExplicitHydratedTargetIds(args.hydratedTargetIds)
      if (!hydratedTargetIds) {
        // Why: an omitted hydration set used to broadcast one session to every
        // SSH target, overwriting unrelated remote workspace snapshots.
        return []
      }
      const sessionTargetId =
        typeof args.sessionTargetId === 'string' && args.sessionTargetId.length > 0
          ? args.sessionTargetId
          : null
      const sessionAuthority = isAdmissibleDirectSshAuthority(args.sessionAuthority)
        ? ({ ...args.sessionAuthority } as DirectSshAuthority)
        : null
      if (
        args.session &&
        (!sessionTargetId ||
          !sessionAuthority ||
          sessionAuthority.targetId !== sessionTargetId ||
          !hydratedTargetIds.has(sessionTargetId) ||
          !isCurrentSshProviderAuthority(sessionAuthority))
      ) {
        return []
      }
      const targets =
        getSshConnectionStore()
          ?.listTargets()
          .filter(
            (target) =>
              hydratedTargetIds.has(target.id) &&
              (!args.session || target.id === sessionTargetId) &&
              getActiveMultiplexer(target.id)
          ) ?? []

      const fallbackSession = args.session ?? store.getWorkspaceSession()
      const results = await Promise.all(
        targets.map(async (target) => {
          // Boot owns persistence; export only overlays stranded SSH state.
          let session: RemoteWorkspaceSession | null
          const authority = args.session ? sessionAuthority : getSshProviderAuthority(target.id)
          if (!authority || !isCurrentSshProviderAuthority(authority)) {
            return null
          }
          if (args.session) {
            session = exportExplicitSessionForTarget(store, authority, args.session)
          } else {
            const targetPartition = store.getWorkspaceSession(toSshExecutionHostId(target.id))
            const ambiguousKeys = findAmbiguousWorkspaceSessionKeys([
              fallbackSession,
              targetPartition
            ])
            const hasPopulatedLocalConflict = [...ambiguousKeys].some(
              (key) => (fallbackSession.tabsByWorktree[key]?.length ?? 0) > 0
            )
            if (hasPopulatedLocalConflict) {
              return null
            }
            session = exportSessionForTarget(
              store,
              authority,
              adoptOrphanedWorkspaceSessionPartition(fallbackSession, targetPartition).session
            )
          }
          if (!session) {
            return null
          }
          // Why: each target has its own revision stream. Keep same-target
          // writes queued, but do not let one slow relay block others.
          const result = await queueRemoteWorkspacePatch(target.id, () =>
            patchRemoteWorkspaceSession(target, session, authority)
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
