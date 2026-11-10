import type { PiUsagePersistedFile } from './types'

/** Backfill old caches in both the main process and scan worker. */
export function normalizePiUsagePersistedFiles(
  files: PiUsagePersistedFile[] | undefined
): PiUsagePersistedFile[] {
  return (files ?? []).map((file) => ({
    ...file,
    sessions: file.sessions ?? [],
    dailyAggregates: file.dailyAggregates ?? [],
    ownedEventKeys: file.ownedEventKeys ?? [],
    hasDeferredClaims: file.hasDeferredClaims ?? true
  }))
}
