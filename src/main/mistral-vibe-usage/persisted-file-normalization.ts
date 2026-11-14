import type { MistralVibeUsagePersistedFile } from './types'

/** Backfill old caches in both the main process and scan worker. */
export function normalizeMistralVibeUsagePersistedFiles(
  files: MistralVibeUsagePersistedFile[] | undefined
): MistralVibeUsagePersistedFile[] {
  const normalized: MistralVibeUsagePersistedFile[] = []
  for (const file of files ?? []) {
    // The sidecar validates only that `sources` is an array, so drop unreadable entries here.
    if (typeof file !== 'object' || file === null) {
      continue
    }
    // A record missing a projection would be reused as empty; discard it so the scanner rebuilds.
    if (!Array.isArray(file.sessions) || !Array.isArray(file.dailyAggregates)) {
      continue
    }
    normalized.push({ ...file, pricingMtimeMs: file.pricingMtimeMs ?? null })
  }
  return normalized
}
