/** Geometry helpers for the main terminal panel (tabs on top + the focused
 *  terminal's output below). Pure so the renderer and mouse hit-testing share
 *  one source of truth. */
import { cellWidth } from './text-width'
import { tabGlyph, type SessionTab } from './session-tab'

/** Cap on terminals listed as tabs for one worktree. */
export const MAX_PANES = 6

const TAB_MAX_LABEL = 18

/** Truncate a terminal title to a tab-friendly width. */
export function truncateTabLabel(title: string, max: number = TAB_MAX_LABEL): string {
  const clean = title.trim().length > 0 ? title.trim() : 'shell'
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** The strip label for a tab (kind glyph + truncated title), without the one
 *  space of padding each side that the renderer and tabRegions add. */
export function tabStripLabel(tab: SessionTab): string {
  return `${tabGlyph(tab.kind)} ${truncateTabLabel(tab.title)}`
}

/** First visible tab index so the focused tab fits within `width` cells. The
 *  strip scrolls horizontally: the renderer and the click hit-test both call
 *  this so a windowed strip stays click-aligned. */
export function tabStripStart(
  tabs: readonly SessionTab[],
  focusedTabId: string | null,
  width: number
): number {
  if (tabs.length === 0) {
    return 0
  }
  const focused = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === (focusedTabId ?? tabs[0].id))
  )
  let start = 0
  while (start < focused) {
    let used = 0
    let end = start
    for (let i = start; i < tabs.length; i += 1) {
      const w = cellWidth(tabStripLabel(tabs[i])) + 2
      if (used + w > width) {
        break
      }
      used += w
      end = i
    }
    if (focused <= end) {
      break
    }
    start += 1
  }
  return start
}

/** The window of tail lines to show in a body of `height` rows, scrolled back
 *  by `scrollOffset` lines (0 = latest at the bottom). */
export function visibleTailLines(
  lines: readonly string[],
  height: number,
  scrollOffset: number
): string[] {
  if (height <= 0) {
    return []
  }
  const end = Math.max(0, lines.length - Math.max(0, scrollOffset))
  const start = Math.max(0, end - height)
  return lines.slice(start, end)
}
