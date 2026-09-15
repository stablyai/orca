/** Capacity after TTL prune — bounds long-lived runtimes with many unique dead ids. */
export const PROVEN_ABSENT_LEAF_PTY_MAX_ENTRIES = 256

/** Drop expired entries, then drop oldest if the cache is still over max. */
export function pruneExpiredProvenAbsentLeafPtyVerdicts(
  verdicts: Map<string, number>,
  nowMs: number,
  ttlMs: number,
  maxEntries: number = PROVEN_ABSENT_LEAF_PTY_MAX_ENTRIES
): void {
  if (ttlMs <= 0) {
    verdicts.clear()
    return
  }
  for (const [ptyId, verdictAt] of verdicts) {
    if (nowMs - verdictAt >= ttlMs) {
      verdicts.delete(ptyId)
    }
  }
  if (verdicts.size <= maxEntries) {
    return
  }
  const oldestFirst = [...verdicts.entries()].sort((a, b) => a[1] - b[1])
  const excess = verdicts.size - maxEntries
  for (let i = 0; i < excess; i += 1) {
    verdicts.delete(oldestFirst[i]![0])
  }
}
