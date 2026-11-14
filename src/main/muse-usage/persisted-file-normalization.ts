import type { MuseUsagePersistedFile } from './types'

/** Backfill old caches in both the main process and scan worker. */
export function normalizeMuseUsagePersistedFiles(
  files: MuseUsagePersistedFile[] | undefined
): MuseUsagePersistedFile[] {
  // A record missing a projection would be reused as zero usage; drop it so the scanner rereads the file.
  return (files ?? []).flatMap((file) =>
    Array.isArray(file?.sessions) && Array.isArray(file.dailyAggregates)
      ? [
          {
            ...file,
            ownedEventKeys: file.ownedEventKeys ?? [],
            hasDeferredClaims: file.hasDeferredClaims ?? true,
            sessionCwd: file.sessionCwd ?? null,
            inheritedCwd: file.inheritedCwd ?? null
          }
        ]
      : []
  )
}
