// Main drops panes before terminal exit: release terminals still in the closed tab or now unbound, but retain those moved to another tab.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

/** Whether the terminal belongs to the tab: main holds it there, or, switch-on, in no pane. */
export function terminalIsOfTab(heldTabId: string | null, parentTabId: string): boolean {
  return heldTabId === parentTabId || (ORCA_LAYOUT_OWNER_IS_MAIN && heldTabId === null)
}

/** Capture main-owned terminals before close drops panes; window-owned layouts look up terminals after close. */
export function liveTerminalsOfTab(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  parentTabId: string,
  find: (row: RuntimeMobileSessionTerminalTab) => RuntimePtyWorktreeRecord | null,
  capture = ORCA_LAYOUT_OWNER_IS_MAIN
): (row: RuntimeMobileSessionTerminalTab) => RuntimePtyWorktreeRecord | null {
  if (!capture) {
    return find
  }
  const live = new Map<
    string,
    { pty: RuntimePtyWorktreeRecord; incarnationId: string | null } | null
  >()
  for (const row of snapshot.tabs) {
    if (row.type === 'terminal' && row.parentTabId === parentTabId) {
      const pty = find(row)
      live.set(row.id, pty ? { pty, incarnationId: pty.incarnationId } : null)
    }
  }
  return (row) => {
    if (!live.has(row.id)) {
      return find(row)
    }
    const captured = live.get(row.id)
    return captured && captured.pty.incarnationId === captured.incarnationId ? captured.pty : null
  }
}
