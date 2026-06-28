/** Pure selection-index math for the worktree list. Kept separate from the Ink app
 *  so navigation is unit-testable without rendering. */

/** Move the selection by `delta`, clamped to [0, total-1]. Returns 0 when the
 *  list is empty so the selection is always valid. */
export function moveSelection(index: number, delta: number, total: number): number {
  if (total <= 0) {
    return 0
  }
  const next = index + delta
  if (next < 0) {
    return 0
  }
  if (next > total - 1) {
    return total - 1
  }
  return next
}

/** Clamp an index into a (possibly shrunk) list so a selection survives worktree
 *  refreshes that remove rows. */
export function clampSelection(index: number, total: number): number {
  if (total <= 0) {
    return 0
  }
  return Math.min(Math.max(index, 0), total - 1)
}

/** First visible index for a scrolling window of `capacity` rows that keeps the
 *  `selected` row on screen (centered when possible). */
export function windowStart(selected: number, total: number, capacity: number): number {
  if (capacity <= 0 || capacity >= total) {
    return 0
  }
  const half = Math.floor(capacity / 2)
  return Math.min(Math.max(selected - half, 0), total - capacity)
}
