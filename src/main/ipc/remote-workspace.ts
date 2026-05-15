/* oxlint-disable max-lines -- Why: remote workspace IPC keeps snapshot normalization, relay compatibility, and handler registration together so revision/cache semantics stay auditable. */
import { randomUUID } from 'crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import { hostname } from 'os'
import { isDeepStrictEqual } from 'util'
import type { Store } from '../persistence'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import {
  exportRemoteWorkspaceSession,
  importRemoteWorkspaceSession
} from '../../shared/remote-workspace-session-projection'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspaceConnectedClient,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/types'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../../shared/worktree-id'
import { getRemoteWorkspaceNamespace } from './remote-workspace-namespace'
import { registerRemoteWorkspaceNotificationHandler } from './remote-workspace-events'

const CLIENT_ID = randomUUID()
const CLIENT_NAME = hostname() || 'This device'
const SNAPSHOT_SCHEMA_VERSION = 1

let mainWindowGetter: (() => BrowserWindow | null) | null = null
const latestSnapshotByTargetId = new Map<string, RemoteWorkspaceSnapshot>()
let unregisterRemoteWorkspaceNotifications: (() => void) | null = null

function emptyRemoteSession(): RemoteWorkspaceSession {
  return {
    activeWorktreePath: null,
    activeTabId: null,
    tabsByWorktreePath: {},
    terminalLayoutsByTabId: {}
  }
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const normalized = value.filter((entry): entry is string => typeof entry === 'string')
  return normalized.length > 0 ? normalized : undefined
}

function normalizeOptionalRecord<T extends Record<string, unknown>>(value: unknown): T | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return Object.keys(value).length > 0 ? (value as T) : undefined
}

function normalizeRemoteSession(raw: unknown): RemoteWorkspaceSession {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyRemoteSession()
  }
  const input = raw as Partial<RemoteWorkspaceSession>
  return {
    activeWorktreePath:
      typeof input.activeWorktreePath === 'string' ? input.activeWorktreePath : null,
    activeTabId: typeof input.activeTabId === 'string' ? input.activeTabId : null,
    tabsByWorktreePath:
      input.tabsByWorktreePath &&
      typeof input.tabsByWorktreePath === 'object' &&
      !Array.isArray(input.tabsByWorktreePath)
        ? input.tabsByWorktreePath
        : {},
    terminalLayoutsByTabId:
      input.terminalLayoutsByTabId &&
      typeof input.terminalLayoutsByTabId === 'object' &&
      !Array.isArray(input.terminalLayoutsByTabId)
        ? input.terminalLayoutsByTabId
        : {},
    activeWorktreePathsOnShutdown: normalizeOptionalStringArray(
      input.activeWorktreePathsOnShutdown
    ),
    activeTabIdByWorktreePath: normalizeOptionalRecord<Record<string, string | null>>(
      input.activeTabIdByWorktreePath
    ),
    remoteSessionIdsByTabId: normalizeOptionalRecord<Record<string, string>>(
      input.remoteSessionIdsByTabId
    ),
    lastVisitedAtByWorktreePath: normalizeOptionalRecord<Record<string, number>>(
      input.lastVisitedAtByWorktreePath
    )
  }
}

function normalizeSnapshot(raw: unknown, fallbackNamespace: string): RemoteWorkspaceSnapshot {
  const input = raw as Partial<RemoteWorkspaceSnapshot> | null
  return {
    namespace: typeof input?.namespace === 'string' ? input.namespace : fallbackNamespace,
    revision:
      typeof input?.revision === 'number' && Number.isFinite(input.revision) ? input.revision : 0,
    updatedAt:
      typeof input?.updatedAt === 'number' && Number.isFinite(input.updatedAt)
        ? input.updatedAt
        : 0,
    schemaVersion:
      typeof input?.schemaVersion === 'number' && Number.isFinite(input.schemaVersion)
        ? input.schemaVersion
        : SNAPSHOT_SCHEMA_VERSION,
    session: normalizeRemoteSession(input?.session)
  }
}

export function remoteWorkspaceSessionMatchesSnapshot(
  snapshot: RemoteWorkspaceSnapshot | undefined,
  session: RemoteWorkspaceSession
): boolean {
  if (!snapshot) {
    return false
  }
  return isDeepStrictEqual(
    normalizeRemoteSession(snapshot.session),
    normalizeRemoteSession(session)
  )
}

function normalizeConnectedClients(
  raw: unknown,
  currentClientId: string
): RemoteWorkspaceConnectedClient[] {
  const clients = (raw as { clients?: unknown } | null)?.clients
  if (!Array.isArray(clients)) {
    return []
  }
  return clients
    .map((entry): RemoteWorkspaceConnectedClient | null => {
      const item = entry as Partial<RemoteWorkspaceConnectedClient> | null
      const clientId = typeof item?.clientId === 'string' ? item.clientId.trim() : ''
      if (!clientId || clientId.length > 200) {
        return null
      }
      return {
        clientId,
        name:
          typeof item?.name === 'string' && item.name.trim()
            ? item.name.replace(/\s+/g, ' ').trim().slice(0, 80)
            : 'Unknown device',
        lastSeenAt:
          typeof item?.lastSeenAt === 'number' && Number.isFinite(item.lastSeenAt)
            ? item.lastSeenAt
            : 0,
        isCurrent: clientId === currentClientId
      }
    })
    .filter((entry): entry is RemoteWorkspaceConnectedClient => entry !== null)
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

function importSessionForTarget(
  store: Store,
  targetId: string,
  remote: RemoteWorkspaceSession
): WorkspaceSessionState {
  const repos = store.getRepos().filter((repo) => repo.connectionId === targetId)
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  return importRemoteWorkspaceSession(remote, {
    resolveWorktreeId: (worktreePath) => {
      for (const repo of repoById.values()) {
        const candidate = `${repo.id}::${worktreePath}`
        // Main does not own the live worktree list for SSH repos, so resolve
        // against repo identity only. Renderer hydration later validates IDs
        // against its fetched worktree list before panes mount.
        if (splitWorktreeId(candidate)) {
          return candidate
        }
      }
      return null
    }
  })
}

async function getRemoteSnapshot(target: SshTarget): Promise<RemoteWorkspaceSnapshot | null> {
  if (!target.remoteWorkspaceSyncEnabled) {
    return null
  }
  const mux = getActiveMultiplexer(target.id)
  if (!mux) {
    return null
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  try {
    const raw = await mux.request('workspace.get', { namespace })
    const snapshot = normalizeSnapshot(raw, namespace)
    latestSnapshotByTargetId.set(target.id, snapshot)
    return snapshot
  } catch (err) {
    if ((err as { code?: unknown })?.code === -32601) {
      return null
    }
    throw err
  }
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
  if (!target?.remoteWorkspaceSyncEnabled) {
    return
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  const snapshot = normalizeSnapshot(params.snapshot, namespace)
  latestSnapshotByTargetId.set(targetId, snapshot)
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
    async (_event, args: { session: WorkspaceSessionState; hydratedTargetIds?: string[] }) => {
      const hydratedTargetIds = Array.isArray(args.hydratedTargetIds)
        ? new Set(args.hydratedTargetIds)
        : null
      const targets =
        getSshConnectionStore()
          ?.listTargets()
          .filter(
            (target) =>
              target.remoteWorkspaceSyncEnabled &&
              getActiveMultiplexer(target.id) &&
              (!hydratedTargetIds || hydratedTargetIds.has(target.id))
          ) ?? []

      const results: { targetId: string; result: RemoteWorkspacePatchResult }[] = []
      for (const target of targets) {
        const mux = getActiveMultiplexer(target.id)
        if (!mux) {
          continue
        }
        const namespace = getRemoteWorkspaceNamespace(target)
        const current =
          latestSnapshotByTargetId.get(target.id) ?? (await getRemoteSnapshot(target)) ?? undefined
        const session = exportSessionForTarget(store, target.id, args.session)
        let result: RemoteWorkspacePatchResult
        if (current && remoteWorkspaceSessionMatchesSnapshot(current, session)) {
          // Why: a pulled workspace snapshot rehydrates local state and can
          // trigger session persistence. Identical target sessions must be a
          // local no-op or two clients will echo revisions indefinitely.
          result = { ok: true, snapshot: current }
          results.push({ targetId: target.id, result })
          continue
        }
        try {
          result = (await mux.request('workspace.patch', {
            namespace,
            baseRevision: current?.revision ?? 0,
            clientId: CLIENT_ID,
            patch: { kind: 'replace-session', session }
          })) as RemoteWorkspacePatchResult
        } catch (err) {
          result =
            (err as { code?: unknown })?.code === -32601
              ? {
                  ok: false,
                  reason: 'unavailable',
                  message: 'Remote workspace sync is unavailable on this relay'
                }
              : {
                  ok: false,
                  reason: 'unavailable',
                  message: err instanceof Error ? err.message : 'Remote workspace sync failed'
                }
        }
        if (result.ok) {
          latestSnapshotByTargetId.set(target.id, result.snapshot)
        }
        results.push({ targetId: target.id, result })
      }
      return results
    }
  )

  ipcMain.handle(
    'remoteWorkspace:listEnabledConnectedTargets',
    async () =>
      getSshConnectionStore()
        ?.listTargets()
        .filter((target) => target.remoteWorkspaceSyncEnabled && getActiveMultiplexer(target.id))
        .map((target) => target.id) ?? []
  )

  ipcMain.handle(
    'remoteWorkspace:listConnectedClients',
    async (_event, args?: { targetIds?: string[] }) => {
      const requestedTargetIds = Array.isArray(args?.targetIds) ? new Set(args.targetIds) : null
      const targets =
        getSshConnectionStore()
          ?.listTargets()
          .filter(
            (target) =>
              target.remoteWorkspaceSyncEnabled &&
              getActiveMultiplexer(target.id) &&
              (!requestedTargetIds || requestedTargetIds.has(target.id))
          ) ?? []
      const results: { targetId: string; clients: RemoteWorkspaceConnectedClient[] }[] = []
      for (const target of targets) {
        const mux = getActiveMultiplexer(target.id)
        if (!mux) {
          continue
        }
        const namespace = getRemoteWorkspaceNamespace(target)
        try {
          const raw = await mux.request('workspace.presence', {
            namespace,
            clientId: CLIENT_ID,
            clientName: CLIENT_NAME
          })
          results.push({
            targetId: target.id,
            clients: normalizeConnectedClients(raw, CLIENT_ID)
          })
        } catch {
          results.push({ targetId: target.id, clients: [] })
        }
      }
      return results
    }
  )

  ipcMain.handle('remoteWorkspace:clientId', () => CLIENT_ID)
}

export function materializeRemoteWorkspaceForTarget(
  store: Store,
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot
): WorkspaceSessionState {
  return importSessionForTarget(store, targetId, snapshot.session)
}
