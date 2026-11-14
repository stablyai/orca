import type { MistralVibeUsagePersistedFile } from './types'

/** Backfill old caches in both the main process and scan worker. */
export function normalizeMistralVibeUsagePersistedFiles(
  files: MistralVibeUsagePersistedFile[] | undefined
): MistralVibeUsagePersistedFile[] {
  return (files ?? []).map((file) => ({
    ...file,
    sessions: file.sessions ?? [],
    dailyAggregates: file.dailyAggregates ?? [],
    pricingMtimeMs: file.pricingMtimeMs ?? null
  }))
}
