/* oxlint-disable max-lines -- Why: remote workspace IPC keeps snapshot normalization, relay compatibility, and handler registration together so revision/cache semantics stay auditable. */
import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import { hostname } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import type { Store } from '../persistence'
import { getActiveMultiplexer, getSshConnectionStore } from './ssh'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspaceConnectedClient,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshTarget } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/types'
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

const CLIENT_ID = randomUUID()
const CLIENT_NAME = hostname() || 'This device'
const SNAPSHOT_SCHEMA_VERSION = 1
export const REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES = 64

let mainWindowGetter: (() => BrowserWindow | null) | null = null
type RemoteWorkspaceSnapshotCacheEntry = {
  authority: DirectSshAuthority
  snapshot: RemoteWorkspaceSnapshot
}

const latestSnapshotByTargetId = new Map<string, RemoteWorkspaceSnapshotCacheEntry>()
const remoteWorkspacePatchTailByTargetId = new Map<string, Promise<void>>()
let unregisterRemoteWorkspaceNotifications: (() => void) | null = null

function rememberRemoteWorkspaceSnapshot(
  authority: DirectSshAuthority,
  snapshot: RemoteWorkspaceSnapshot
): void {
  if (!isCurrentSshProviderAuthority(authority)) {
    return
  }
  const targetId = authority.targetId
  if (latestSnapshotByTargetId.has(targetId)) {
    latestSnapshotByTargetId.delete(targetId)
  }
  latestSnapshotByTargetId.set(targetId, { authority: { ...authority }, snapshot })
  while (latestSnapshotByTargetId.size > REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldest = latestSnapshotByTargetId.keys().next()
    if (oldest.done) {
      break
    }
    latestSnapshotByTargetId.delete(oldest.value)
  }
}

function authoritiesEqual(left: DirectSshAuthority, right: DirectSshAuthority): boolean {
  return (
    left.targetId === right.targetId &&
    left.providerEpoch === right.providerEpoch &&
    left.connectionGeneration === right.connectionGeneration
  )
}

function getCachedRemoteWorkspaceSnapshot(
  authority: DirectSshAuthority
): RemoteWorkspaceSnapshot | undefined {
  const entry = latestSnapshotByTargetId.get(authority.targetId)
  if (!entry) {
    return undefined
  }
  if (!authoritiesEqual(entry.authority, authority) || !isCurrentSshProviderAuthority(authority)) {
    latestSnapshotByTargetId.delete(authority.targetId)
    return undefined
  }
  // Why: remote workspace snapshots can contain the whole tab/layout session
  // for a target. Touch cache hits so deleted or rarely used targets age out.
  latestSnapshotByTargetId.delete(authority.targetId)
  latestSnapshotByTargetId.set(authority.targetId, entry)
  return entry.snapshot
}

export function _resetRemoteWorkspaceCachesForTests(): void {
  latestSnapshotByTargetId.clear()
  remoteWorkspacePatchTailByTargetId.clear()
}

export function _getRemoteWorkspaceCacheSizesForTests(): {
  snapshots: number
  patchTails: number
} {
  return {
    snapshots: latestSnapshotByTargetId.size,
    patchTails: remoteWorkspacePatchTailByTargetId.size
  }
}

/** @internal - exposed for cache-bound tests only. */
export function _rememberRemoteWorkspaceSnapshotForTests(
  authority: DirectSshAuthority,
  snapshot: RemoteWorkspaceSnapshot
): void {
  const targetId = authority.targetId
  latestSnapshotByTargetId.delete(targetId)
  latestSnapshotByTargetId.set(targetId, { authority: { ...authority }, snapshot })
  while (latestSnapshotByTargetId.size > REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldest = latestSnapshotByTargetId.keys().next()
    if (oldest.done) {
      break
    }
    latestSnapshotByTargetId.delete(oldest.value)
  }
}

/** @internal - exposed for cache-bound tests only. */
export function _getRemoteWorkspaceSnapshotForTests(
  authority: DirectSshAuthority
): RemoteWorkspaceSnapshot | undefined {
  const entry = latestSnapshotByTargetId.get(authority.targetId)
  if (!entry || !authoritiesEqual(entry.authority, authority)) {
    return undefined
  }
  latestSnapshotByTargetId.delete(authority.targetId)
  latestSnapshotByTargetId.set(authority.targetId, entry)
  return entry.snapshot
}

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

async function getRemoteSnapshot(
  target: SshTarget,
  authority: DirectSshAuthority
): Promise<RemoteWorkspaceSnapshot | null> {
  const mux = getActiveMultiplexer(target.id)
  if (!mux || authority.targetId !== target.id || !isCurrentSshProviderAuthority(authority)) {
    return null
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  try {
    const raw = await mux.request('workspace.get', { namespace })
    if (!isCurrentSshProviderAuthority(authority)) {
      return null
    }
    const snapshot = normalizeSnapshot(raw, namespace)
    rememberRemoteWorkspaceSnapshot(authority, snapshot)
    return snapshot
  } catch (err) {
    if (!isCurrentSshProviderAuthority(authority)) {
      return null
    }
    if ((err as { code?: unknown })?.code === -32601) {
      return null
    }
    throw err
  }
}

async function queueRemoteWorkspacePatch<T>(
  targetId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = remoteWorkspacePatchTailByTargetId.get(targetId) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.catch(() => {}).then(() => tail)
  remoteWorkspacePatchTailByTargetId.set(targetId, queued)

  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    if (remoteWorkspacePatchTailByTargetId.get(targetId) === queued) {
      remoteWorkspacePatchTailByTargetId.delete(targetId)
    }
  }
}

async function patchRemoteWorkspaceSession(
  target: SshTarget,
  session: RemoteWorkspaceSession,
  authority: DirectSshAuthority
): Promise<RemoteWorkspacePatchResult | null> {
  if (authority.targetId !== target.id || !isCurrentSshProviderAuthority(authority)) {
    return null
  }
  const mux = getActiveMultiplexer(target.id)
  if (!mux) {
    return null
  }
  const namespace = getRemoteWorkspaceNamespace(target)
  const current =
    getCachedRemoteWorkspaceSnapshot(authority) ??
    (await getRemoteSnapshot(target, authority)) ??
    undefined
  if (!isCurrentSshProviderAuthority(authority)) {
    return null
  }
  if (current && remoteWorkspaceSessionMatchesSnapshot(current, session)) {
    // Why: a pulled workspace snapshot rehydrates local state and can trigger
    // session persistence. Identical target sessions must stay a local no-op or
    // two clients will echo revisions indefinitely.
    return { ok: true, snapshot: current }
  }

  const requestPatch = async (
    baseRevision: number | undefined
  ): Promise<RemoteWorkspacePatchResult | null> => {
    if (!isCurrentSshProviderAuthority(authority)) {
      return null
    }
    try {
      return (await mux.request('workspace.patch', {
        namespace,
        baseRevision: baseRevision ?? 0,
        clientId: CLIENT_ID,
        patch: { kind: 'replace-session', session }
      })) as RemoteWorkspacePatchResult
    } catch (err) {
      if (!isCurrentSshProviderAuthority(authority)) {
        return null
      }
      return (err as { code?: unknown })?.code === -32601
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
  }

  const result = await requestPatch(current?.revision)
  if (!result) {
    return null
  }
  if (result.ok) {
    rememberRemoteWorkspaceSnapshot(authority, result.snapshot)
    return result
  }
  if (result.snapshot) {
    rememberRemoteWorkspaceSnapshot(authority, result.snapshot)
  }

  if (
    result.reason === 'stale-revision' &&
    current &&
    result.snapshot &&
    result.snapshot.revision < current.revision
  ) {
    if (remoteWorkspaceSessionMatchesSnapshot(result.snapshot, session)) {
      return { ok: true, snapshot: result.snapshot }
    }
    // Why: a relay reset can legitimately move the remote snapshot revision
    // backwards while this process still has the old cached revision. Retrying
    // only for backwards revisions restores the blank-slate target without
    // overwriting a newer snapshot from another device.
    const retry = await requestPatch(result.snapshot.revision)
    if (!retry) {
      return null
    }
    if (retry.ok) {
      rememberRemoteWorkspaceSnapshot(authority, retry.snapshot)
    } else if (retry.snapshot) {
      rememberRemoteWorkspaceSnapshot(authority, retry.snapshot)
    }
    return retry
  }

  return result
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
    async (_event, args?: { targetIds?: string[] }) => {
      const requestedTargetIds = Array.isArray(args?.targetIds) ? new Set(args.targetIds) : null
      const targets =
        getSshConnectionStore()
          ?.listTargets()
          .filter(
            (target) =>
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
