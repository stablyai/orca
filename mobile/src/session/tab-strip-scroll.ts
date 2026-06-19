export type TabStripScrollInput = {
  tabX: number
  tabWidth: number
  viewportWidth: number
  contentWidth: number
  currentOffset: number
  margin?: number
}

/**
 * Keep active-tab reveal deterministic across async RN layout events without
 * nudging the strip when the tab is already visible.
 */
export function resolveTabStripScrollOffset({
  tabX,
  tabWidth,
  viewportWidth,
  contentWidth,
  currentOffset,
  margin = 12
}: TabStripScrollInput): number {
  const maxOffset = Math.max(0, contentWidth - viewportWidth)
  if (viewportWidth <= 0) {
    return currentOffset
  }

  const visibleStart = currentOffset
  const visibleEnd = currentOffset + viewportWidth
  const tabStart = tabX
  const tabEnd = tabX + tabWidth

  let nextOffset = currentOffset
  if (tabStart < visibleStart + margin) {
    nextOffset = tabStart - margin
  } else if (tabEnd > visibleEnd - margin) {
    nextOffset = tabEnd + margin - viewportWidth
  }

  return Math.min(Math.max(0, nextOffset), maxOffset)
}
