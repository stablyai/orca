import { optionalNumberParam, optionalStringParam } from './desktop-script-provider-params'
import type { BridgeSnapshot } from './desktop-script-provider-types'

export const MAX_CACHED_DESKTOP_SNAPSHOTS = 32
// Why: cached element frames and provider IDs are follow-up hints, not durable
// state; delayed agents should refresh instead of acting on old UI geometry.
export const MAX_CACHED_DESKTOP_SNAPSHOT_AGE_MS = 2 * 60 * 1000

export type CachedSnapshotEntry = {
  snapshot: BridgeSnapshot
  keys: string[]
  createdAtMs: number
}

export function snapshotCacheKeys(
  query: string,
  snapshot: BridgeSnapshot,
  params: Record<string, unknown>
): string[] {
  const namespace = snapshotNamespace(params)
  const pidKeys = snapshotPidKeys(snapshot.app.pid)
  const keys = new Set<string>()
  if (snapshot.windowId !== null && snapshot.windowId !== undefined) {
    keys.add(canonicalWindowIdKey(snapshot.windowId))
    keys.add(namespacedSnapshotKey(namespace, canonicalWindowIdKey(snapshot.windowId)))
  }
  const resolvedWindowIndex = optionalNumberParam(params, 'windowIndex') ?? snapshot.windowIndex
  if (resolvedWindowIndex !== null && resolvedWindowIndex !== undefined) {
    keys.add(canonicalWindowIndexKey(resolvedWindowIndex))
    keys.add(namespacedSnapshotKey(namespace, canonicalWindowIndexKey(resolvedWindowIndex)))
  }

  for (const key of [
    query,
    snapshot.app.name,
    snapshot.app.bundleId,
    snapshot.app.bundleIdentifier,
    ...pidKeys,
    ...snapshotKeysForWindow(query, snapshot),
    ...snapshotKeysForWindow(snapshot.app.name, snapshot),
    ...(snapshot.app.bundleId ? snapshotKeysForWindow(snapshot.app.bundleId, snapshot) : []),
    ...(snapshot.app.bundleIdentifier
      ? snapshotKeysForWindow(snapshot.app.bundleIdentifier, snapshot)
      : []),
    ...pidKeys.flatMap((pidKey) => snapshotKeysForWindow(pidKey, snapshot)),
    ...snapshotKeysForWindowIndex(query, snapshot, params),
    ...snapshotKeysForWindowIndex(snapshot.app.name, snapshot, params),
    ...(snapshot.app.bundleId
      ? snapshotKeysForWindowIndex(snapshot.app.bundleId, snapshot, params)
      : []),
    ...(snapshot.app.bundleIdentifier
      ? snapshotKeysForWindowIndex(snapshot.app.bundleIdentifier, snapshot, params)
      : []),
    ...pidKeys.flatMap((pidKey) => snapshotKeysForWindowIndex(pidKey, snapshot, params))
  ]) {
    if (!key) {
      continue
    }
    if (!isExplicitSnapshotNamespace(namespace)) {
      keys.add(key.toLowerCase())
    }
    keys.add(namespacedSnapshotKey(namespace, key))
  }
  return [...keys]
}

function snapshotKeysForWindow(query: string, snapshot: BridgeSnapshot): string[] {
  return snapshot.windowId === null || snapshot.windowId === undefined
    ? []
    : [snapshotWindowKey(query, snapshot.windowId)]
}

export function snapshotWindowKey(query: string, windowId: number): string {
  return `${query.toLowerCase()}#window:${windowId}`
}

export function canonicalWindowIdKey(windowId: number): string {
  return `window-id:${windowId}`
}

export function canonicalWindowIndexKey(windowIndex: number): string {
  return `window-index:${windowIndex}`
}

function snapshotKeysForWindowIndex(
  query: string,
  snapshot: BridgeSnapshot,
  params: Record<string, unknown>
): string[] {
  const windowIndex = optionalNumberParam(params, 'windowIndex') ?? snapshot.windowIndex
  return windowIndex === null || windowIndex === undefined
    ? []
    : [snapshotWindowIndexKey(query, windowIndex)]
}

export function snapshotWindowIndexKey(query: string, windowIndex: number): string {
  return `${query.toLowerCase()}#window-index:${windowIndex}`
}

export function snapshotNamespace(params: Record<string, unknown>): string {
  const session = optionalStringParam(params, 'session')
  const worktree = optionalStringParam(params, 'worktree')
  return session ? `session:${session}` : worktree ? `worktree:${worktree}` : 'default'
}

export function namespacedSnapshotKey(namespace: string, key: string): string {
  return `${namespace}:${key.toLowerCase()}`
}

export function staleWindowTargetKeys(
  query: string,
  params: Record<string, unknown>,
  snapshot: BridgeSnapshot | null
): string[] {
  const namespace = snapshotNamespace(params)
  const windowId = optionalNumberParam(params, 'windowId')
  const windowIndex = optionalNumberParam(params, 'windowIndex')
  if (windowId === undefined && windowIndex === undefined) {
    return []
  }

  const keys = new Set<string>()
  if (windowId !== undefined) {
    keys.add(canonicalWindowIdKey(windowId))
    keys.add(namespacedSnapshotKey(namespace, canonicalWindowIdKey(windowId)))
  }
  if (windowIndex !== undefined) {
    keys.add(canonicalWindowIndexKey(windowIndex))
    keys.add(namespacedSnapshotKey(namespace, canonicalWindowIndexKey(windowIndex)))
  }
  for (const appKey of snapshotAppKeys(query, snapshot)) {
    const targetKey =
      windowId !== undefined
        ? snapshotWindowKey(appKey, windowId)
        : snapshotWindowIndexKey(appKey, windowIndex!)
    if (!isExplicitSnapshotNamespace(namespace)) {
      keys.add(targetKey.toLowerCase())
    }
    keys.add(namespacedSnapshotKey(namespace, targetKey))
  }
  return [...keys]
}

export function lookupCachedSnapshotKey(
  app: string,
  params: Record<string, unknown>,
  windowId: number | undefined,
  windowIndex: number | undefined
): string[] {
  const namespace = snapshotNamespace(params)
  const keys: string[] = []
  if (windowId !== undefined) {
    keys.push(
      namespacedSnapshotKey(namespace, canonicalWindowIdKey(windowId)),
      namespacedSnapshotKey(namespace, snapshotWindowKey(app, windowId))
    )
    if (!isExplicitSnapshotNamespace(namespace)) {
      keys.push(canonicalWindowIdKey(windowId), snapshotWindowKey(app, windowId))
    }
  }
  if (windowIndex !== undefined) {
    keys.push(
      namespacedSnapshotKey(namespace, canonicalWindowIndexKey(windowIndex)),
      namespacedSnapshotKey(namespace, snapshotWindowIndexKey(app, windowIndex))
    )
    if (!isExplicitSnapshotNamespace(namespace)) {
      keys.push(canonicalWindowIndexKey(windowIndex), snapshotWindowIndexKey(app, windowIndex))
    }
  }
  keys.push(namespacedSnapshotKey(namespace, app))
  if (!isExplicitSnapshotNamespace(namespace)) {
    keys.push(app.toLowerCase())
  }
  return keys
}

function snapshotAppKeys(query: string, snapshot: BridgeSnapshot | null): string[] {
  return [
    query,
    snapshot?.app.name,
    snapshot?.app.bundleId,
    snapshot?.app.bundleIdentifier,
    ...(snapshot ? snapshotPidKeys(snapshot.app.pid) : [])
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
}

function snapshotPidKeys(pid: number): string[] {
  if (!Number.isInteger(pid) || pid <= 0) {
    return []
  }
  return [snapshotPidSelector(pid), String(pid)]
}

function snapshotPidSelector(pid: number): string {
  return `pid:${pid}`
}

export function isExplicitSnapshotNamespace(namespace: string): boolean {
  return namespace !== 'default'
}
