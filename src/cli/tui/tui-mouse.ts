import { worktreeSelector } from './action-dispatch'
import { handleKey, type ControllerOverlay } from './tui-input'
import { overlayClick } from './overlay-frame'
import { toOverlayModel } from './frame-derivation'
import type { Platform } from './keybinding-map'
import {
  buildSidebarLines,
  rowIndexAtScreenRow,
  sidebarWindowStart,
  tabAtScreenRow,
  type SidebarLine
} from './sidebar-lines'
import { tabStripLabel, tabStripStart } from './pane-layout'
import { cellWidth } from './text-width'
import { windowStart } from './navigation-state'
import { BACK_LABEL, HEADER_ROWS, STRIP_WIDTH } from './tui-layout'
import type { ControllerHost } from './tui-input'
import type { MouseEvent } from './mouse-input'

/** Lines moved per scroll-wheel tick when scrolling the focused terminal. */
const SCROLL_LINES = 3

/** Route a click while a dialog is open: map it to yes/no/dismiss and feed the
 *  overlay key path (y confirms; anything else cancels/dismisses). */
export function routeOverlayClick(
  host: ControllerHost,
  overlay: ControllerOverlay,
  inputValue: string,
  platform: Platform,
  size: { columns: number; rows: number },
  event: MouseEvent
): void {
  if (event.type !== 'press' || event.button !== 'left') {
    return
  }
  const model = toOverlayModel(overlay, inputValue, platform)
  const action = overlayClick(model, size.columns, size.rows, event.col, event.row)
  if (action) {
    handleKey(host, action === 'confirm' ? { type: 'char', value: 'y' } : { type: 'escape' })
  }
}

export function handleMouse(host: ControllerHost, event: MouseEvent): void {
  if (event.type === 'scroll') {
    // When the terminal is focused the wheel scrolls its history (up = older);
    // otherwise it moves the worktree selection.
    if (host.terminalFocused()) {
      host.scrollTerminal(event.direction === 'up' ? SCROLL_LINES : -SCROLL_LINES)
    } else {
      host.move(event.direction === 'down' ? 1 : -1)
    }
    return
  }
  if (event.type !== 'press' || (event.button !== 'left' && event.button !== 'right')) {
    return
  }
  const right = event.button === 'right'
  if (host.fileBrowserOpen()) {
    // Tapping the Files bar again closes it; clicking a row opens/expands it.
    if (event.row === 0) {
      host.toggleFiles()
    } else if (!right) {
      host.clickFile(event.row)
    }
    return
  }
  // The header's right segment is the Files button.
  if (event.row === 0) {
    if (!right && event.col >= host.sidebarWidth()) {
      host.toggleFiles()
    }
    return
  }
  if (host.isNarrow()) {
    routeNarrowMouse(host, event.col, event.row, right)
    return
  }
  routeWideMouse(host, event.col, event.row, right)
}

/** Wide layout: nested tab line jumps to that tab (right-click or re-clicking the
 *  focused tab asks to close it); a *different* workspace switches+focuses it
 *  (right-click asks to close it); the selected workspace (or empty space)
 *  focuses the workspace area; the tab strip / viewport focus the terminal. */
function routeWideMouse(host: ControllerHost, col: number, row: number, right: boolean): void {
  if (col < host.sidebarWidth()) {
    // Sidebar clicks only navigate — closing a tab is reserved for the top strip.
    const { lines, lineIndex } = sidebarHit(host, row)
    const tab = tabAtScreenRow(lines, lineIndex)
    if (tab) {
      host.jumpToTab(tab.index, tab.id)
      return
    }
    const target = rowIndexAtScreenRow(lines, lineIndex)
    if (target === null || target === host.selectedIndex()) {
      host.exitTerminalFocus()
    } else {
      host.selectIndex(target)
      host.focusTerminal()
    }
  } else if (row === HEADER_ROWS) {
    // Tab strip is flush against the divider bar (sidebarWidth + 1), unlike the
    // body below it which keeps the one-space margin (sidebarWidth + 2).
    focusTabAt(host, host.sidebarWidth() + 1, col, right)
  } else if (!right) {
    host.focusTerminal()
    // Body click → editor cursor (body starts below header+tab strip; right pane
    // at sidebarWidth + 2). No-op unless this tab is an editable file.
    host.editorClick(row - HEADER_ROWS - 1, col - host.sidebarWidth() - 2)
  }
}

function routeNarrowMouse(host: ControllerHost, col: number, row: number, right: boolean): void {
  if (host.narrowView() === 'list') {
    // Sidebar clicks only navigate; closing is reserved for the top tab strip.
    const { lines, lineIndex } = sidebarHit(host, row)
    const tab = tabAtScreenRow(lines, lineIndex)
    if (tab) {
      host.jumpToTab(tab.index, tab.id)
      host.setNarrowView('terminal')
      return
    }
    const target = rowIndexAtScreenRow(lines, lineIndex)
    if (target !== null) {
      host.selectIndex(target)
      host.setNarrowView('terminal')
    }
    return
  }
  if (row === 0 && col < BACK_LABEL.length) {
    host.setNarrowView('list')
    return
  }
  if (col < STRIP_WIDTH && row >= HEADER_ROWS) {
    const total = host.worktreeRows().length
    const start = windowStart(host.selectedIndex(), total, host.bodyHeight())
    const index = start + (row - HEADER_ROWS)
    if (index >= 0 && index < total) {
      host.selectIndex(index)
    }
    return
  }
  if (row === HEADER_ROWS) {
    focusTabAt(host, STRIP_WIDTH + 1, col, right)
  }
}

/** Build the sidebar lines (with nested tabs) the same way the renderer does,
 *  and resolve which line a screen row hit — honoring the scroll window so the
 *  hit-test never drifts from what's drawn. */
function sidebarHit(
  host: ControllerHost,
  screenRow: number
): { lines: readonly SidebarLine[]; lineIndex: number } {
  const lines = buildSidebarLines(host.snapshot(), host.resolveKind, {
    tabsByWorktree: host.tabsByWorktree(),
    expanded: host.tabsExpanded(),
    focusedTabId: host.focusedTabId()
  })
  const start = sidebarWindowStart(lines, host.selectedIndex(), host.bodyHeight())
  return { lines, lineIndex: start + (screenRow - HEADER_ROWS) }
}

/** Resolve a click on the right-pane tab strip to a tab, mirroring the renderer:
 *  the strip scrolls to the focused tab, the first visible tab is flush (one
 *  trailing pad), and later tabs add a leading pad — so clicks stay aligned. */
function focusTabAt(host: ControllerHost, originX: number, col: number, right: boolean): void {
  const tabs = host.terminals()
  const start = tabStripStart(tabs, host.focusedTabId(), host.columns() - originX)
  let x = originX
  for (let i = start; i < tabs.length; i += 1) {
    const w = cellWidth(tabStripLabel(tabs[i])) + (i === start ? 1 : 2)
    if (col >= x && col < x + w) {
      tabClick(host, host.selectedIndex(), tabs[i].id, right)
      return
    }
    x += w
  }
}

/** Right-click or re-clicking the focused tab asks to close it; otherwise jump. */
function tabClick(host: ControllerHost, index: number, tabId: string, right: boolean): void {
  if (right || tabId === host.focusedTabId()) {
    requestCloseTab(host, index, tabId)
  } else {
    host.jumpToTab(index, tabId)
    host.focusTerminal()
  }
}

/** Select the tab's worktree and ask to close the tab (session.tabs.close). */
function requestCloseTab(host: ControllerHost, index: number, tabId: string): void {
  host.selectIndex(index)
  // Resolve the tab within its own worktree (by index) so colliding tab ids
  // across worktrees can't close the wrong one.
  const worktreeId = host.worktreeRows()[index]?.worktreeId
  if (!worktreeId) {
    return
  }
  const tab = host
    .tabsByWorktree()
    .get(worktreeId)
    ?.find((candidate) => candidate.id === tabId)
  if (!tab) {
    return
  }
  host.setOverlay({
    kind: 'confirm',
    message: `Close "${tab.title}"?`,
    command: { kind: 'session.tabs.close', worktree: worktreeSelector(worktreeId), tabId }
  })
}
