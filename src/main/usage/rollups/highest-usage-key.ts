// Preserve stable-sort ties with strict > so the first-inserted key wins.
export function highestUsageKey(totals: ReadonlyMap<string, number>): string | null {
  let bestKey: string | null = null
  let bestTotal = Number.NEGATIVE_INFINITY
  for (const [key, total] of totals) {
    if (Number.isNaN(total)) {
      // NaN breaks comparator consistency; retain the original sort to preserve corrupt-total behavior.
      return [...totals].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
    }
    if (bestKey === null || total > bestTotal) {
      bestKey = key
      bestTotal = total
    }
  }
  return bestKey
}
