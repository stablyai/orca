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
  find: (row: RuntimeMobileSessionTerminalTab) => RuntimePtyWorktreeRecord | null
): (row: RuntimeMobileSessionTerminalTab) => RuntimePtyWorktreeRecord | null {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return find
  }
  const live = new Map<string, RuntimePtyWorktreeRecord | null>()
  for (const row of snapshot.tabs) {
    if (row.type === 'terminal' && row.parentTabId === parentTabId) {
      live.set(row.id, find(row))
    }
  }
  return (row) => live.get(row.id) ?? find(row)
}
