/**
 * Controller-proven PTY absence cache helpers (#12578 / #12660).
 * Entries are timestamps; expired keys must not accumulate for process lifetime.
 */

export const PROVEN_ABSENT_LEAF_PTY_TTL_MS = 15_000
/** Capacity after TTL prune — bounds long-lived runtimes with many unique dead ids. */
export const PROVEN_ABSENT_LEAF_PTY_MAX_ENTRIES = 256

/** Delete expired timestamp entries; if still over max, drop oldest first. */
export function pruneProvenAbsentLeafPtyVerdicts(
  map: Map<string, number>,
  now: number = Date.now(),
  ttlMs: number = PROVEN_ABSENT_LEAF_PTY_TTL_MS,
  maxEntries: number = PROVEN_ABSENT_LEAF_PTY_MAX_ENTRIES
): void {
  for (const [ptyId, verdictAt] of map) {
    if (now - verdictAt >= ttlMs) {
      map.delete(ptyId)
    }
  }
  if (map.size <= maxEntries) {
    return
  }
  const oldestFirst = [...map.entries()].sort((a, b) => a[1] - b[1])
  const excess = map.size - maxEntries
  for (let i = 0; i < excess; i += 1) {
    map.delete(oldestFirst[i]![0])
  }
}

/** Record a verdict and restore the TTL/cap invariants before returning. */
export function recordProvenAbsentLeafPtyVerdict(
  map: Map<string, number>,
  ptyId: string,
  now: number = Date.now(),
  ttlMs: number = PROVEN_ABSENT_LEAF_PTY_TTL_MS,
  maxEntries: number = PROVEN_ABSENT_LEAF_PTY_MAX_ENTRIES
): void {
  map.set(ptyId, now)
  pruneProvenAbsentLeafPtyVerdicts(map, now, ttlMs, maxEntries)
}
