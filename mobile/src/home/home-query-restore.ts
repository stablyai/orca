import AsyncStorage from '@react-native-async-storage/async-storage'
import type { QueryClient } from '@tanstack/react-query'
import * as z from 'zod'
import {
  HOST_LIST_TARGET,
  homeWorktreeCountsKey,
  NO_HOST_LIST_INPUT
} from '../host-screen/host-list-queries'
import { hostObserverOptions } from '../query/host-query'
import { accountsSnapshotFamily, accountsSnapshotKey } from '../accounts/accounts-snapshot-stream'
import { persistedHostQueryKey } from '../query/host-query-persistence'
import { keepNativeHostQueries, nativeQueryStoreReady } from '../query/native-query-persistence'
import { homeStatsKey, homeStatsQuery } from '../stats/home-stats-summary-read'
import { loadStoredHostProfiles } from '../transport/hosts/host-metadata-store'
import {
  homeWorktreeCountsQuery,
  type HomeWorktreeCounts
} from '../worktree/home-host-worktree-fetch'

// Where Home kept its counts before the device store: read once to seed the store, then removed.
const LEGACY_SNAPSHOT_KEY = 'orca:home-snapshot:v1'

const legacySnapshotSchema = z.object({
  savedAt: z.number(),
  worktreeInfo: z.record(
    z.string(),
    z.looseObject({
      totalWorktrees: z.number().int().nonnegative(),
      activeCount: z.number().int().nonnegative(),
      catalogUnavailable: z.boolean().optional(),
      staleCounts: z.boolean().optional(),
      countsProvenAt: z.number().optional()
    })
  )
})

type LegacySnapshot = z.infer<typeof legacySnapshotSchema>

// Null when there is no old key; an unreadable one seeds nothing and is removed all the same.
async function readLegacySnapshot(): Promise<LegacySnapshot | null> {
  const raw = await AsyncStorage.getItem(LEGACY_SNAPSHOT_KEY).catch(() => null)
  if (raw === null) {
    return null
  }
  try {
    const parsed = legacySnapshotSchema.safeParse(JSON.parse(raw))
    if (parsed.success) {
      return parsed.data
    }
  } catch {
    // Falls through to the empty seed.
  }
  return { savedAt: 0, worktreeInfo: {} }
}

// Counts nothing stored yet answers; the old key goes once the store holds them. Without a readable host
// list or a store that can write (web, a key that won't load), the key waits for a later launch.
function seedFromLegacySnapshot(
  queryClient: QueryClient,
  snapshot: LegacySnapshot,
  hostIds: readonly string[]
): void {
  for (const hostId of hostIds) {
    const info = snapshot.worktreeInfo[hostId]
    const key = homeWorktreeCountsKey(hostId)
    // Counts the old cache never proved are no seed.
    if (!info || (info.catalogUnavailable && !info.staleCounts) || queryClient.getQueryData(key)) {
      continue
    }
    const counts: HomeWorktreeCounts = {
      totalWorktrees: info.totalWorktrees,
      activeCount: info.activeCount,
      agents: []
    }
    // Built with the family's rules first: setQueryData alone makes a query the store never writes.
    queryClient
      .getQueryCache()
      .build(
        queryClient,
        hostObserverOptions(
          homeWorktreeCountsQuery,
          null,
          hostId,
          HOST_LIST_TARGET,
          NO_HOST_LIST_INPUT
        )
      )
    queryClient.setQueryData(key, counts, { updatedAt: info.countsProvenAt ?? snapshot.savedAt })
  }
  // Off the first paint's path: the seeded counts already show.
  void Promise.all(
    hostIds.map(
      (hostId) => keepNativeHostQueries(queryClient, hostId)?.flush() ?? Promise.resolve()
    )
  ).then(() => AsyncStorage.removeItem(LEGACY_SNAPSHOT_KEY).catch(() => undefined))
}

/** Restores each paired desktop's stored Home rows; resolves once each is applied or missed. */
export async function restoreHomeQueries(queryClient: QueryClient): Promise<void> {
  // Independent first reads: the paired hosts, the store's key (keychain) and the old snapshot key.
  const [hosts, storeReady, legacy] = await Promise.all([
    loadStoredHostProfiles().catch(() => null),
    nativeQueryStoreReady(),
    readLegacySnapshot()
  ])
  const hostIds = hosts?.map((host) => host.id) ?? null
  if (!hostIds || !storeReady) {
    return
  }
  await Promise.all(
    hostIds.map(
      (hostId) =>
        keepNativeHostQueries(queryClient, hostId)?.restore(
          [
            persistedHostQueryKey(homeStatsQuery, homeStatsKey(hostId)),
            persistedHostQueryKey(homeWorktreeCountsQuery, homeWorktreeCountsKey(hostId)),
            // Stored for the Accounts page; read here so Home's own observer doesn't read it alone.
            persistedHostQueryKey(accountsSnapshotFamily, accountsSnapshotKey(hostId))
          ].filter((key) => key !== null)
        ) ?? Promise.resolve()
    )
  )
  if (legacy) {
    seedFromLegacySnapshot(queryClient, legacy, hostIds)
  }
}
