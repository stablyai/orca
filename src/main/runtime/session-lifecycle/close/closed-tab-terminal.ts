// Layout-owner builds: main's close drops a tab's panes before their terminals exit. Until the
// exit, a terminal no pane of main's layout holds is still the closed tab's, so its ownership is
// released with that tab; one main moved to another tab keeps it.
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

/** A row's live terminal. Switch-on it is read before main's close drops the panes it is found
 *  by; window-owned builds look it up when asked, after the close. */
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
