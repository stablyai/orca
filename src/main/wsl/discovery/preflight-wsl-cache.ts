export function prunePreflightWslCache(
  cached: Map<string, { expiresAt: number }>,
  latestRuns: Map<string, number>,
  now: number,
  maxEntries: number
): void {
  for (const [key, entry] of cached) {
    if (entry.expiresAt <= now) {
      cached.delete(key)
    }
  }
  while (cached.size > maxEntries) {
    const oldest = cached.keys().next().value
    if (oldest === undefined) {
      break
    }
    cached.delete(oldest)
    latestRuns.delete(oldest)
  }
  while (latestRuns.size > maxEntries) {
    const oldest = latestRuns.keys().next().value
    if (oldest === undefined) {
      break
    }
    latestRuns.delete(oldest)
  }
}
