import type { MuseUsagePersistedFile } from './types'

/** Backfill old caches in both the main process and scan worker. */
export function normalizeMuseUsagePersistedFiles(
  files: MuseUsagePersistedFile[] | undefined
): MuseUsagePersistedFile[] {
  return (files ?? []).map((file) => ({
    ...file,
    // A record missing a projection must be reread, not reused as zero usage; keep its claims so a deleted owner still frees them.
    ...(Array.isArray(file.sessions) && Array.isArray(file.dailyAggregates)
      ? {}
      : { sessions: [], dailyAggregates: [], mtimeMs: -1, size: -1 }),
    ownedEventKeys: file.ownedEventKeys ?? [],
    hasDeferredClaims: file.hasDeferredClaims ?? true,
    sessionCwd: file.sessionCwd ?? null,
    inheritedCwd: file.inheritedCwd ?? null
  }))
}
