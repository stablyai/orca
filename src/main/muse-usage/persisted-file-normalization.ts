import type { MuseUsagePersistedFile } from './types'

/** Backfill old caches in both the main process and scan worker. */
export function normalizeMuseUsagePersistedFiles(
  files: MuseUsagePersistedFile[] | undefined
): MuseUsagePersistedFile[] {
  return (files ?? []).map((file) => ({
    ...file,
    sessions: file.sessions ?? [],
    dailyAggregates: file.dailyAggregates ?? [],
    ownedEventKeys: file.ownedEventKeys ?? [],
    hasDeferredClaims: file.hasDeferredClaims ?? true,
    sessionCwd: file.sessionCwd ?? null,
    inheritedCwd: file.inheritedCwd ?? null
  }))
}
