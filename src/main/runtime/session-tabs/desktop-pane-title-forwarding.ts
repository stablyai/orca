import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { TerminalPaneLayoutNode, TerminalTab } from '../../../shared/terminal-tab-types'
import { sanitizeTerminalLayoutPaneTitles } from '../../../shared/terminal-pane-title-sanitization'

function collectLeafIds(node: TerminalPaneLayoutNode | null): string[] {
  if (!node) {
    return []
  }
  return node.type === 'leaf'
    ? [node.leafId]
    : [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
}

/**
 * The per-pane names a client's layout asks a desktop window to show. The client sends its whole
 * title map, so a pane it lists without a name is a clear. A single pane named after its own tab
 * is not a pane name, so the tab's name never becomes one.
 */
export function paneTitlesForDesktopWindow(args: {
  root: TerminalPaneLayoutNode | null
  titlesByLeafId: Record<string, string>
  tab: TerminalTab | undefined
}): { leafId: string; title: string | null }[] {
  const layout = {
    root: args.root,
    activeLeafId: null,
    expandedLeafId: null,
    titlesByLeafId: args.titlesByLeafId
  }
  const titles = (args.tab ? sanitizeTerminalLayoutPaneTitles(layout, args.tab) : layout)
    .titlesByLeafId
  return (
    collectLeafIds(args.root)
      .filter(isTerminalLeafId)
      // A name dropped as the tab's own is neither set nor cleared on the window's pane.
      .filter((leafId) => !args.titlesByLeafId[leafId]?.trim() || Boolean(titles?.[leafId]))
      .map((leafId) => ({ leafId, title: titles?.[leafId]?.trim() || null }))
  )
}
