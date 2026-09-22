import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import { normalizeSnapshot } from './remote-workspace-snapshot-normalization'

export const REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES = 64

type RemoteWorkspaceSnapshotCacheEntry = {
  snapshot: RemoteWorkspaceObservedSnapshot
  // Why: overlapping renderer writes retain their applied base until earlier same-client patches acknowledge.
  minimumAuthorizedRevision: number
  maximumAuthorizedRevision: number
}

const latestSnapshotByTargetId = new Map<string, RemoteWorkspaceSnapshotCacheEntry>()

function snapshotsAreIdentical(
  previous: RemoteWorkspaceObservedSnapshot,
  next: RemoteWorkspaceSnapshot
): boolean {
  return (
    previous.namespace === next.namespace &&
    previous.revision === next.revision &&
    previous.updatedAt === next.updatedAt &&
    previous.schemaVersion === next.schemaVersion &&
    // Why no scalar-only fast path: same revision with different session content is a
    // genuinely new host observation (new token, reset auth window) — the patch-queue
    // and cache tests pin this. Skipping the walk here mis-authorizes local patches.
    isDeepStrictEqual(previous.session, next.session)
  )
}

function rememberRemoteWorkspaceSnapshotEntry(
  targetId: string,
  entry: RemoteWorkspaceSnapshotCacheEntry
): void {
  if (latestSnapshotByTargetId.has(targetId)) {
    latestSnapshotByTargetId.delete(targetId)
  }
  latestSnapshotByTargetId.set(targetId, entry)
  while (latestSnapshotByTargetId.size > REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldest = latestSnapshotByTargetId.keys().next()
    if (oldest.done) {
      break
    }
    latestSnapshotByTargetId.delete(oldest.value)
  }
}

export function rememberRemoteWorkspaceSnapshot(
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot
): RemoteWorkspaceObservedSnapshot {
  // Relay responses can carry legacy empty optional fields that normalization
  // removes on reads. Keep one canonical shape in the cache so equivalent
  // observations do not revoke an in-flight upload authority.
  const normalizedSnapshot = normalizeSnapshot(snapshot, snapshot.namespace)
  const current = latestSnapshotByTargetId.get(targetId)
  if (current && snapshotsAreIdentical(current.snapshot, normalizedSnapshot)) {
    // Re-reading an unchanged revision is not a new host observation. Keep the
    // token (and the contiguous local-patch authorization window) stable so a
    // polling read cannot invalidate an upload that is already in flight.
    const observedSnapshot = {
      ...normalizedSnapshot,
      hostObservationToken: current.snapshot.hostObservationToken
    }
    rememberRemoteWorkspaceSnapshotEntry(targetId, {
      ...current,
      snapshot: observedSnapshot
    })
    return observedSnapshot
  }
  const observedSnapshot = { ...normalizedSnapshot, hostObservationToken: randomUUID() }
  rememberRemoteWorkspaceSnapshotEntry(targetId, {
    snapshot: observedSnapshot,
    minimumAuthorizedRevision: normalizedSnapshot.revision,
    maximumAuthorizedRevision: normalizedSnapshot.revision
  })
  return observedSnapshot
}

export function rememberLocallyPatchedRemoteWorkspaceSnapshot(
  targetId: string,
  snapshot: RemoteWorkspaceSnapshot
): RemoteWorkspaceObservedSnapshot {
  const normalizedSnapshot = normalizeSnapshot(snapshot, snapshot.namespace)
  const current = latestSnapshotByTargetId.get(targetId)
  if (!current || normalizedSnapshot.revision > current.maximumAuthorizedRevision + 1) {
    return rememberRemoteWorkspaceSnapshot(targetId, normalizedSnapshot)
  }
  if (normalizedSnapshot.revision < current.snapshot.revision) {
    rememberRemoteWorkspaceSnapshotEntry(targetId, current)
    return current.snapshot
  }
  const observedSnapshot = {
    ...normalizedSnapshot,
    hostObservationToken: current.snapshot.hostObservationToken
  }
  rememberRemoteWorkspaceSnapshotEntry(targetId, {
    snapshot: observedSnapshot,
    minimumAuthorizedRevision: current.minimumAuthorizedRevision,
    maximumAuthorizedRevision: Math.max(
      current.maximumAuthorizedRevision,
      normalizedSnapshot.revision
    )
  })
  return observedSnapshot
}

export function getCachedRemoteWorkspaceSnapshot(
  targetId: string
): RemoteWorkspaceObservedSnapshot | undefined {
  const entry = latestSnapshotByTargetId.get(targetId)
  if (!entry) {
    return undefined
  }
  // Why: remote workspace snapshots can contain the whole tab/layout session
  // for a target. Touch cache hits so deleted or rarely used targets age out.
  rememberRemoteWorkspaceSnapshotEntry(targetId, entry)
  return entry.snapshot
}

export function cachedRemoteWorkspaceSnapshotAuthorizesRevision(
  targetId: string,
  revision: number
): boolean {
  const entry = latestSnapshotByTargetId.get(targetId)
  return (
    entry !== undefined &&
    revision >= entry.minimumAuthorizedRevision &&
    revision <= entry.maximumAuthorizedRevision
  )
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
): RemoteWorkspaceObservedSnapshot | undefined {
  return getCachedRemoteWorkspaceSnapshot(targetId)
}
