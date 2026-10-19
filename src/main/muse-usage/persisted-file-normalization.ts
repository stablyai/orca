import type { MuseUsagePersistedFile } from './types'

/** Fills fields older Muse caches never wrote. Electron-free: the scan worker runs it too. */
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
