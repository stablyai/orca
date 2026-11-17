/** Drop cache entries whose TTL has elapsed without requiring a re-probe of that ptyId. */
export function pruneExpiredProvenAbsentLeafPtyVerdicts(
  verdicts: Map<string, number>,
  nowMs: number,
  ttlMs: number
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
}
