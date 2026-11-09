import AsyncStorage from '@react-native-async-storage/async-storage'
import type { QueryClient } from '@tanstack/react-query'
import * as z from 'zod'
import { persistedHostQueryKey } from '../query/host-query-persistence'
import { keepNativeHostQueries } from '../query/native-query-persistence'
import { homeStatsKey, homeStatsQuery } from '../stats/home-stats-summary-read'
import { loadStoredHostProfiles } from '../transport/hosts/host-metadata-store'
import {
  homeWorktreeCountsKey,
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

// Counts nothing stored yet answers; removes the old key once the store holds them.
async function seedFromLegacySnapshot(
  queryClient: QueryClient,
  hostIds: readonly string[]
): Promise<void> {
  const snapshot = await readLegacySnapshot()
  if (!snapshot) {
    return
  }
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
    queryClient.setQueryData(key, counts, { updatedAt: info.countsProvenAt ?? snapshot.savedAt })
  }
  await Promise.all(hostIds.map((hostId) => keepNativeHostQueries(queryClient, hostId)?.flush()))
  await AsyncStorage.removeItem(LEGACY_SNAPSHOT_KEY).catch(() => undefined)
}

/** Restores each paired desktop's stored counts and totals; resolves once each is applied or missed. */
export async function restoreHomeQueries(queryClient: QueryClient): Promise<void> {
  const hosts = await loadStoredHostProfiles().catch(() => null)
  const hostIds = hosts?.map((host) => host.id) ?? []
  await Promise.all(
    hostIds.map((hostId) =>
      keepNativeHostQueries(queryClient, hostId)?.restore(
        [
          persistedHostQueryKey(homeStatsQuery, homeStatsKey(hostId)),
          persistedHostQueryKey(homeWorktreeCountsQuery, homeWorktreeCountsKey(hostId))
        ].filter((key) => key !== null)
      )
    )
  )
  await seedFromLegacySnapshot(queryClient, hostIds)
}
