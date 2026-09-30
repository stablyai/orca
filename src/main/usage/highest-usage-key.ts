// Replaces a stable descending sort, so ties must resolve to the first-inserted
// key — hence the strict `>` below rather than `>=`.
export function highestUsageKey(totals: ReadonlyMap<string, number>): string | null {
  let bestKey: string | null = null
  let bestTotal = Number.NEGATIVE_INFINITY
  for (const [key, total] of totals) {
    if (Number.isNaN(total)) {
      // NaN makes the old comparator inconsistent; defer to it verbatim so a
      // corrupt total cannot change which key the summary reports.
      return [...totals].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
    }
    if (bestKey === null || total > bestTotal) {
      bestKey = key
      bestTotal = total
    }
  }
  return bestKey
}
