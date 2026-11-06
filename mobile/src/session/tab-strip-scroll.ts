import type { AgentDotState } from '../worktree/agent-row-display'

export type TabStripScrollInput = {
  tabX: number
  tabWidth: number
  viewportWidth: number
  contentWidth: number
  currentOffset: number
  margin?: number
}

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

type TabLayouts = ReadonlyMap<string, { x: number; width: number }>

export function resolveTabStripTapOffset(args: {
  tabId: string
  tabs: readonly { id: string }[]
  layouts: TabLayouts
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
  const selectedOnly = resolveTabStripScrollOffset({
    tabX: selected.x,
    tabWidth: selected.width,
    viewportWidth,
    contentWidth,
    currentOffset
  })
  if (selectedOnly === currentOffset) {
    return currentOffset
  }
  const left = selected.x + selected.width / 2 < currentOffset + viewportWidth / 2
  const neighbor = tabs[index + (left ? -1 : 1)]
  const layout = neighbor ? layouts.get(neighbor.id) : undefined
  let start = selected.x
  let end = selected.x + selected.width
  if (layout) {
    const gap = left ? selected.x - (layout.x + layout.width) : layout.x - end
    // Keep the tapped tab whole while revealing as much of its neighbor as fits within both margins.
    const peek = Math.min(layout.width, Math.max(0, viewportWidth - 24 - selected.width - gap))
    if (left) {
      start -= gap + peek
    } else {
      end += gap + peek
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

export type TabStripHiddenTabs = { left: readonly string[]; right: readonly string[] }

export function resolveTabStripHiddenTabs(args: {
  layouts: TabLayouts
  viewportWidth: number
  currentOffset: number
}): TabStripHiddenTabs {
  const left: string[] = []
  const right: string[] = []
  if (args.viewportWidth > 0) {
    for (const [tabId, layout] of args.layouts) {
      const center = layout.x + layout.width / 2
      if (center < args.currentOffset) {
        left.push(tabId)
      } else if (center > args.currentOffset + args.viewportWidth) {
        right.push(tabId)
      }
    }
  }
  return { left, right }
}

// Lower ranks win when several hidden tabs share an edge; other states get no edge hint.
const EDGE_HINT_RANK: Partial<Record<AgentDotState, number>> = {
  blocked: 0,
  waiting: 0,
  working: 1,
  monitoring: 1
}

export function resolveTabStripEdgeHint(
  tabIds: readonly string[],
  tabStates: ReadonlyMap<string, AgentDotState>
): AgentDotState | null {
  let hint: AgentDotState | null = null
  for (const tabId of tabIds) {
    const state = tabStates.get(tabId)
    const rank = state ? EDGE_HINT_RANK[state] : undefined
    if (state && rank !== undefined && (hint === null || rank < (EDGE_HINT_RANK[hint] ?? 0))) {
      hint = state
    }
  }
  return hint
}
