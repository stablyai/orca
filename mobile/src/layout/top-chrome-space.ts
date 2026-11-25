import type { ReservedRect } from '../../modules/orca-reserved-regions/src'

/** A header can share a top strip only when the system reports its full edge obstruction. */
export function topChromeSpace(
  frame: ReservedRect | null,
  topInset: number,
  occlusions: readonly ReservedRect[]
): { left: number; right: number; minHeight: number } | null {
  if (!frame || topInset <= 0 || frame.width <= 0) {
    return null
  }
  const end = frame.x + frame.width
  const obstacles = occlusions.filter(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.x < end &&
      rect.x + rect.width > frame.x &&
      rect.y < frame.y + topInset &&
      rect.y + rect.height > frame.y
  )
  if (
    !obstacles.some(
      (rect) =>
        rect.y <= frame.y + 1 &&
        rect.y + rect.height >= frame.y + topInset - 1 &&
        (rect.x <= frame.x + 1 || rect.x + rect.width >= end - 1)
    )
  ) {
    return null
  }
  const spans = obstacles
    .map((rect) => ({
      start: Math.max(frame.x, rect.x),
      end: Math.min(end, rect.x + rect.width)
    }))
    .sort((a, b) => a.start - b.start)
  let cursor = frame.x
  let best = { start: frame.x, end: frame.x }
  for (const span of [...spans, { start: end, end }]) {
    if (span.start - cursor > best.end - best.start) {
      best = { start: cursor, end: span.start }
    }
    cursor = Math.max(cursor, span.end)
  }
  // Keep a usable tab strip; a camera island or full-width status bar cannot donate a header row.
  if (best.end - best.start < 240) {
    return null
  }
  return { left: best.start - frame.x, right: end - best.end, minHeight: topInset }
}
