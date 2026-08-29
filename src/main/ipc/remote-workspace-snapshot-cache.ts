import type { RemoteWorkspaceSnapshot } from '../../shared/remote-workspace-types'

export const REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES = 64

const latestSnapshotByTargetId = new Map<string, RemoteWorkspaceSnapshot>()

export function rememberRemoteWorkspaceSnapshot(
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot
): void {
  if (latestSnapshotByTargetId.has(targetId)) {
    latestSnapshotByTargetId.delete(targetId)
  }
  latestSnapshotByTargetId.set(targetId, snapshot)
  while (latestSnapshotByTargetId.size > REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldest = latestSnapshotByTargetId.keys().next()
    if (oldest.done) {
      break
    }
    latestSnapshotByTargetId.delete(oldest.value)
  }
}

export function getCachedRemoteWorkspaceSnapshot(
  targetId: string
): RemoteWorkspaceSnapshot | undefined {
  const snapshot = latestSnapshotByTargetId.get(targetId)
  if (!snapshot) {
    return undefined
  }
  // Why: remote workspace snapshots can contain the whole tab/layout session
  // for a target. Touch cache hits so deleted or rarely used targets age out.
  rememberRemoteWorkspaceSnapshot(targetId, snapshot)
  return snapshot
}

export function clearRemoteWorkspaceSnapshotCache(): void {
  latestSnapshotByTargetId.clear()
}

export function getRemoteWorkspaceSnapshotCacheSize(): number {
  return latestSnapshotByTargetId.size
}

/** @internal - exposed for cache-bound tests only. */
export function _rememberRemoteWorkspaceSnapshotForTests(
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot
): void {
  rememberRemoteWorkspaceSnapshot(targetId, snapshot)
}

/** @internal - exposed for cache-bound tests only. */
export function _getRemoteWorkspaceSnapshotForTests(
  targetId: string
): RemoteWorkspaceSnapshot | undefined {
  return getCachedRemoteWorkspaceSnapshot(targetId)
}
