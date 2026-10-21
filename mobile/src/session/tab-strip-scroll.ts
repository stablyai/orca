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

/** Reveal the neighbor on the tapped edge without waiting for host activation. */
export function resolveTabStripTapOffset(args: {
  tabId: string
  tabs: readonly { id: string }[]
  layouts: ReadonlyMap<string, { x: number; width: number }>
  viewportWidth: number
  contentWidth: number
  currentOffset: number
}): number {
  const { tabs, layouts, viewportWidth, contentWidth, currentOffset } = args
  const index = tabs.findIndex((tab) => tab.id === args.tabId)
  const selected = layouts.get(args.tabId)
  if (index === -1 || !selected || viewportWidth <= 0) {
    return currentOffset
  }
  const left = selected.x + selected.width / 2 < currentOffset + viewportWidth / 2
  const neighbor = tabs[index + (left ? -1 : 1)]
  const layout = neighbor ? layouts.get(neighbor.id) : undefined
  let start = selected.x
  let end = selected.x + selected.width
  if (layout) {
    const gap = left ? selected.x - (layout.x + layout.width) : layout.x - end
    // Keep the selected title visible; show as much of its neighbor as the viewport permits.
    const peek = Math.min(layout.width, Math.max(0, viewportWidth - 24 - selected.width - gap))
    if (peek > 0) {
      if (left) {
        start = layout.x + layout.width - peek
      } else {
        end = layout.x + peek
      }
    }
  }
  return resolveTabStripScrollOffset({
    tabX: start,
    tabWidth: end - start,
    viewportWidth,
    contentWidth,
    currentOffset
  })
}
