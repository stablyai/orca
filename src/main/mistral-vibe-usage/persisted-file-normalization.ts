import type { MistralVibeUsagePersistedFile } from './types'

/** Backfill old caches in both the main process and scan worker. */
export function normalizeMistralVibeUsagePersistedFiles(
  files: MistralVibeUsagePersistedFile[] | undefined
): MistralVibeUsagePersistedFile[] {
  // A record missing a projection would be reused as zero usage; drop it so the scanner rereads the file.
  return (files ?? []).flatMap((file) =>
    Array.isArray(file.sessions) && Array.isArray(file.dailyAggregates)
      ? [{ ...file, pricingMtimeMs: file.pricingMtimeMs ?? null }]
      : []
  )
}
