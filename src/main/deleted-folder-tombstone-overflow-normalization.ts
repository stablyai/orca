import type {
  DeletedFolderWorkspaceSessionTombstoneOverflowBucket,
  WorkspaceKey
} from '../shared/types'
import {
  DELETED_FOLDER_OVERFLOW_BUCKET_MS,
  MAX_DELETED_FOLDER_OVERFLOW_BUCKETS,
  MAX_DELETED_FOLDER_OVERFLOW_IDENTITIES_PER_KIND,
  MAX_DELETED_FOLDER_TOMBSTONE_RETENTION_MS
} from './deleted-folder-session-tombstones'

function normalizeIdentities(value: unknown): { identities: string[]; changed: boolean } {
  if (!Array.isArray(value)) {
    return { identities: [], changed: true }
  }
  const identities = [
    ...new Set(value.filter((identity): identity is string => typeof identity === 'string'))
  ].slice(0, MAX_DELETED_FOLDER_OVERFLOW_IDENTITIES_PER_KIND)
  return {
    identities,
    changed:
      identities.length !== value.length ||
      identities.some((identity, index) => identity !== value[index])
  }
}

export function normalizeDeletedFolderTombstoneOverflowBuckets(
  value: unknown,
  now: number
): {
  buckets: DeletedFolderWorkspaceSessionTombstoneOverflowBucket[]
  changed: boolean
} {
  if (!Array.isArray(value)) {
    return { buckets: [], changed: value !== undefined }
  }
  const bucketsByStart = new Map<number, DeletedFolderWorkspaceSessionTombstoneOverflowBucket>()
  let changed = false
  for (const candidate of value) {
    const raw = candidate as Partial<DeletedFolderWorkspaceSessionTombstoneOverflowBucket> | null
    if (
      !raw ||
      typeof raw.bucketStart !== 'number' ||
      !Number.isFinite(raw.bucketStart) ||
      typeof raw.expiresAt !== 'number' ||
      !Number.isFinite(raw.expiresAt) ||
      raw.expiresAt <= now
    ) {
      changed = true
      continue
    }
    const bucketStart =
      Math.floor(raw.bucketStart / DELETED_FOLDER_OVERFLOW_BUCKET_MS) *
      DELETED_FOLDER_OVERFLOW_BUCKET_MS
    const expiresAt = Math.min(
      raw.expiresAt,
      bucketStart + DELETED_FOLDER_OVERFLOW_BUCKET_MS + MAX_DELETED_FOLDER_TOMBSTONE_RETENTION_MS
    )
    const workspaceKeys = normalizeIdentities(raw.workspaceKeys)
    const tabOwnerKeys = normalizeIdentities(raw.tabOwnerKeys)
    const connectionIds = normalizeIdentities(raw.connectionIds)
    if (
      bucketStart !== raw.bucketStart ||
      expiresAt !== raw.expiresAt ||
      workspaceKeys.changed ||
      tabOwnerKeys.changed ||
      connectionIds.changed
    ) {
      changed = true
    }
    if (bucketStart > now || expiresAt <= now) {
      changed = true
      continue
    }
    const existing = bucketsByStart.get(bucketStart)
    if (existing) {
      existing.workspaceKeys = normalizeIdentities([
        ...existing.workspaceKeys,
        ...workspaceKeys.identities
      ]).identities as WorkspaceKey[]
      existing.tabOwnerKeys = normalizeIdentities([
        ...existing.tabOwnerKeys,
        ...tabOwnerKeys.identities
      ]).identities
      existing.connectionIds = normalizeIdentities([
        ...existing.connectionIds,
        ...connectionIds.identities
      ]).identities
      existing.expiresAt = Math.max(existing.expiresAt, expiresAt)
      changed = true
      continue
    }
    bucketsByStart.set(bucketStart, {
      bucketStart,
      expiresAt,
      workspaceKeys: workspaceKeys.identities as WorkspaceKey[],
      tabOwnerKeys: tabOwnerKeys.identities,
      connectionIds: connectionIds.identities
    })
  }
  const retained = [...bucketsByStart.values()]
    .sort((left, right) => left.bucketStart - right.bucketStart)
    .slice(-MAX_DELETED_FOLDER_OVERFLOW_BUCKETS)
  return { buckets: retained, changed: changed || retained.length !== value.length }
}
