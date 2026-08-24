import type { RemoteWorkspaceSnapshot } from '../../shared/remote-workspace-types'
import type { DirectSshAuthority } from '../../shared/ssh-types'
import { isCurrentSshProviderAuthority } from '../ssh/ssh-provider-authority'

export const REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES = 64

type RemoteWorkspaceSnapshotCacheEntry = {
  authority: DirectSshAuthority
  snapshot: RemoteWorkspaceSnapshot
}

const latestSnapshotByTargetId = new Map<string, RemoteWorkspaceSnapshotCacheEntry>()

function authoritiesEqual(left: DirectSshAuthority, right: DirectSshAuthority): boolean {
  return (
    left.targetId === right.targetId &&
    left.providerEpoch === right.providerEpoch &&
    left.connectionGeneration === right.connectionGeneration
  )
}

export function rememberRemoteWorkspaceSnapshot(
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

export function getCachedRemoteWorkspaceSnapshot(
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

export function clearRemoteWorkspaceSnapshotCache(): void {
  latestSnapshotByTargetId.clear()
}

export function getRemoteWorkspaceSnapshotCacheSize(): number {
  return latestSnapshotByTargetId.size
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
