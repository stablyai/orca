import type { ExecutionHostId } from '../shared/execution-host'
import type {
  DeletedFolderWorkspaceSessionTombstone,
  DeletedFolderWorkspaceSessionTombstoneOverflowBucket,
  PersistedState,
  WorkspaceKey
} from '../shared/types'

const MAX_TOMBSTONES = 512
export const MAX_DELETED_FOLDER_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const DELETED_FOLDER_OVERFLOW_BUCKET_MS = 24 * 60 * 60 * 1000
export const MAX_DELETED_FOLDER_OVERFLOW_BUCKETS = 31
export const MAX_DELETED_FOLDER_OVERFLOW_IDENTITIES_PER_KIND = 512
const MAX_HOST_IDS = 32
const MAX_TAB_OWNERS = 256
const overflowIdentityCache = new WeakMap<
  DeletedFolderWorkspaceSessionTombstoneOverflowBucket,
  {
    workspaceKeys: ReadonlySet<string>
    tabOwnerKeys: ReadonlySet<string>
    connectionIds: ReadonlySet<string>
  }
>()

export type DeletedFolderTombstoneOverflowEntry = {
  deletedAt: number
  workspaceKey?: WorkspaceKey
  tabOwners?: readonly { hostId: ExecutionHostId; tabId: string }[]
  connectionIds?: readonly string[]
}

export type BoundedDeletedFolderTombstoneEvidence = {
  tombstone: DeletedFolderWorkspaceSessionTombstone
  overflowEntry: DeletedFolderTombstoneOverflowEntry | null
}

function getTabOwnerKey(hostId: ExecutionHostId, tabId: string): string {
  return `${hostId}\0${tabId}`
}

function getTombstoneTabEntries(tombstone: DeletedFolderWorkspaceSessionTombstone) {
  return Object.entries(tombstone.tabConnectionIdsByHostId).flatMap(([hostId, tabs]) =>
    Object.entries(tabs ?? {}).map(
      ([tabId, connectionId]) => [hostId as ExecutionHostId, tabId, connectionId] as const
    )
  )
}

export function getBoundedDeletedFolderTombstoneEvidence(
  tombstone: DeletedFolderWorkspaceSessionTombstone
): BoundedDeletedFolderTombstoneEvidence {
  const tabEntries = getTombstoneTabEntries(tombstone)
  const retainedTabCandidates = tabEntries.slice(Math.max(0, tabEntries.length - MAX_TAB_OWNERS))
  const candidateHostIds = [
    ...new Set([...tombstone.hostIds, ...retainedTabCandidates.map(([hostId]) => hostId)])
  ]
  const retainedHostIds = candidateHostIds.slice(-MAX_HOST_IDS)
  const retainedHostIdSet = new Set(retainedHostIds)
  const retainedTabOwnerKeys = new Set<string>()
  const tabConnectionIdsByHostId: DeletedFolderWorkspaceSessionTombstone['tabConnectionIdsByHostId'] =
    {}
  for (const [hostId, tabId, connectionId] of retainedTabCandidates) {
    if (!retainedHostIdSet.has(hostId)) {
      continue
    }
    retainedTabOwnerKeys.add(getTabOwnerKey(hostId, tabId))
    tabConnectionIdsByHostId[hostId] = {
      ...tabConnectionIdsByHostId[hostId],
      [tabId]: connectionId
    }
  }
  const discardedTabEntries = tabEntries.filter(
    ([hostId, tabId]) => !retainedTabOwnerKeys.has(getTabOwnerKey(hostId, tabId))
  )
  const evidenceTruncated =
    tombstone.evidenceTruncated ||
    discardedTabEntries.length > 0 ||
    candidateHostIds.length > MAX_HOST_IDS
  return {
    tombstone: {
      ...tombstone,
      evidenceTruncated,
      hostIds: retainedHostIds,
      tabConnectionIdsByHostId
    },
    overflowEntry:
      discardedTabEntries.length > 0
        ? {
            deletedAt: tombstone.deletedAt,
            tabOwners: discardedTabEntries.map(([hostId, tabId]) => ({ hostId, tabId })),
            connectionIds: discardedTabEntries.flatMap(([, , connectionId]) =>
              connectionId ? [connectionId] : []
            )
          }
        : null
  }
}

function getTombstoneOverflowEntry(
  workspaceKey: WorkspaceKey,
  tombstone: DeletedFolderWorkspaceSessionTombstone
): DeletedFolderTombstoneOverflowEntry {
  const tabEntries = getTombstoneTabEntries(tombstone)
  return {
    deletedAt: tombstone.deletedAt,
    workspaceKey,
    tabOwners: tabEntries.map(([hostId, tabId]) => ({ hostId, tabId })),
    connectionIds: [
      ...(tombstone.connectionId ? [tombstone.connectionId] : []),
      ...tabEntries.flatMap(([, , connectionId]) => (connectionId ? [connectionId] : []))
    ]
  }
}

export function getDeletedFolderTombstoneEviction(
  tombstones: NonNullable<PersistedState['deletedFolderWorkspaceSessionTombstones']>,
  now: number
): { workspaceKeys: WorkspaceKey[]; overflowEntries: DeletedFolderTombstoneOverflowEntry[] } {
  const entries = Object.entries(tombstones).flatMap(([workspaceKey, tombstone], index) =>
    tombstone ? [{ index, workspaceKey: workspaceKey as WorkspaceKey, tombstone }] : []
  )
  const expired = entries.filter(
    ({ tombstone }) => now - tombstone.deletedAt >= MAX_DELETED_FOLDER_TOMBSTONE_RETENTION_MS
  )
  const expiredKeys = new Set(expired.map(({ workspaceKey }) => workspaceKey))
  const retained = entries.filter(({ workspaceKey }) => !expiredKeys.has(workspaceKey))
  const excess = Math.max(0, retained.length - MAX_TOMBSTONES)
  const capEvictions =
    excess === 0
      ? []
      : retained
          .sort((left, right) =>
            left.tombstone.deletedAt === right.tombstone.deletedAt
              ? left.index - right.index
              : left.tombstone.deletedAt - right.tombstone.deletedAt
          )
          .slice(0, excess)
  return {
    workspaceKeys: [
      ...expired.map(({ workspaceKey }) => workspaceKey),
      ...capEvictions.map(({ workspaceKey }) => workspaceKey)
    ],
    overflowEntries: capEvictions.map(({ workspaceKey, tombstone }) =>
      getTombstoneOverflowEntry(workspaceKey, tombstone)
    )
  }
}

function addBoundedIdentities(retained: Set<string>, additions: readonly string[]): void {
  for (const addition of additions) {
    if (retained.size >= MAX_DELETED_FOLDER_OVERFLOW_IDENTITIES_PER_KIND) {
      break
    }
    retained.add(addition)
  }
}

export function addDeletedFolderTombstoneOverflowEntries(
  current: DeletedFolderWorkspaceSessionTombstoneOverflowBucket[] | undefined,
  entries: readonly DeletedFolderTombstoneOverflowEntry[],
  now: number
): DeletedFolderWorkspaceSessionTombstoneOverflowBucket[] {
  const buckets = pruneDeletedFolderTombstoneOverflowBuckets(current, now) ?? []
  if (entries.length === 0) {
    return buckets
  }
  const bucketsByStart = new Map(buckets.map((bucket) => [bucket.bucketStart, bucket]))
  const mutableByStart = new Map<
    number,
    {
      expiresAt: number
      workspaceKeys: Set<string>
      tabOwnerKeys: Set<string>
      connectionIds: Set<string>
    }
  >()
  for (const entry of entries) {
    const bucketStart =
      Math.floor(entry.deletedAt / DELETED_FOLDER_OVERFLOW_BUCKET_MS) *
      DELETED_FOLDER_OVERFLOW_BUCKET_MS
    const existing = bucketsByStart.get(bucketStart)
    const mutable = mutableByStart.get(bucketStart) ?? {
      expiresAt: existing?.expiresAt ?? 0,
      workspaceKeys: new Set(existing?.workspaceKeys ?? []),
      tabOwnerKeys: new Set(existing?.tabOwnerKeys ?? []),
      connectionIds: new Set(existing?.connectionIds ?? [])
    }
    addBoundedIdentities(mutable.workspaceKeys, entry.workspaceKey ? [entry.workspaceKey] : [])
    addBoundedIdentities(
      mutable.tabOwnerKeys,
      (entry.tabOwners ?? []).map(({ hostId, tabId }) => getTabOwnerKey(hostId, tabId))
    )
    addBoundedIdentities(mutable.connectionIds, entry.connectionIds ?? [])
    mutable.expiresAt = Math.max(
      mutable.expiresAt,
      entry.deletedAt + MAX_DELETED_FOLDER_TOMBSTONE_RETENTION_MS
    )
    mutableByStart.set(bucketStart, mutable)
  }
  for (const [bucketStart, mutable] of mutableByStart) {
    bucketsByStart.set(bucketStart, {
      bucketStart,
      expiresAt: mutable.expiresAt,
      workspaceKeys: [...mutable.workspaceKeys] as WorkspaceKey[],
      tabOwnerKeys: [...mutable.tabOwnerKeys],
      connectionIds: [...mutable.connectionIds]
    })
  }
  return [...bucketsByStart.values()]
    .sort((left, right) => left.bucketStart - right.bucketStart)
    .slice(-MAX_DELETED_FOLDER_OVERFLOW_BUCKETS)
}

export function pruneDeletedFolderTombstoneOverflowBuckets(
  current: DeletedFolderWorkspaceSessionTombstoneOverflowBucket[] | undefined,
  now: number
): DeletedFolderWorkspaceSessionTombstoneOverflowBucket[] | undefined {
  if (!current) {
    return undefined
  }
  const retained = current.filter((bucket) => bucket.expiresAt > now)
  return retained.length === current.length ? current : retained
}

function getOverflowIdentities(bucket: DeletedFolderWorkspaceSessionTombstoneOverflowBucket) {
  const cached = overflowIdentityCache.get(bucket)
  if (cached) {
    return cached
  }
  const identities = {
    workspaceKeys: new Set(bucket.workspaceKeys),
    tabOwnerKeys: new Set(bucket.tabOwnerKeys),
    connectionIds: new Set(bucket.connectionIds)
  }
  overflowIdentityCache.set(bucket, identities)
  return identities
}

export function hasDeletedFolderWorkspaceKeyOverflowEvidence(
  buckets: readonly DeletedFolderWorkspaceSessionTombstoneOverflowBucket[] | undefined,
  workspaceKey: string,
  now: number
): boolean {
  return (buckets ?? []).some(
    (bucket) =>
      bucket.expiresAt > now && getOverflowIdentities(bucket).workspaceKeys.has(workspaceKey)
  )
}

export function hasDeletedFolderTabOwnerOverflowEvidence(
  buckets: readonly DeletedFolderWorkspaceSessionTombstoneOverflowBucket[] | undefined,
  hostId: ExecutionHostId,
  tabId: string,
  now: number
): boolean {
  const tabOwnerKey = getTabOwnerKey(hostId, tabId)
  return (buckets ?? []).some(
    (bucket) =>
      bucket.expiresAt > now && getOverflowIdentities(bucket).tabOwnerKeys.has(tabOwnerKey)
  )
}

export function hasDeletedFolderConnectionOverflowEvidence(
  buckets: readonly DeletedFolderWorkspaceSessionTombstoneOverflowBucket[] | undefined,
  connectionId: string,
  now: number
): boolean {
  return (buckets ?? []).some(
    (bucket) =>
      bucket.expiresAt > now && getOverflowIdentities(bucket).connectionIds.has(connectionId)
  )
}
