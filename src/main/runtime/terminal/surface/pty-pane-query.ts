// L80: the one reader of a PTY record's pane copies (`tabId`, `paneKey`, their graph stamp).
// Layout-owner builds answer from main's layout alone and never touch the copies; the copies and
// the switch-off branch below are deleted together with the window-owned path.

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'

export type PtyPane = {
  tabId: string | null
  paneKey: string | null
  /** The graph sequence the pane is good as of; see pty-recorded-surface-topology.ts. */
  recordedAtGraphSequence: number
}

export type PtyPaneSource = Pick<
  RuntimePtyWorktreeRecord,
  'ptyId' | 'tabId' | 'paneKey' | 'surfaceRecordedAtGraphSequence'
>

/** How a helper outside the runtime asks for a terminal's pane: the runtime's `paneOfPty`. */
export type PtyPaneOf = (pty: PtyPaneSource) => PtyPane

/** The pane main's layout binds a terminal to; null when no pane main owns holds it. */
export type MainPaneOfPty = (ptyId: string) => { tabId: string; leafId: string } | null

const NO_PANE: PtyPane = Object.freeze({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 })

/** The tab and pane that hold a terminal; null fields when none does or there is no record. */
export function paneOfPty(
  pty: PtyPaneSource | null | undefined,
  mainPaneOf: MainPaneOfPty
): PtyPane {
  if (!pty) {
    return NO_PANE
  }
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    const pane = mainPaneOf(pty.ptyId)
    if (!pane) {
      return NO_PANE
    }
    // Main's binding is current by definition, so no graph statement outranks it.
    return {
      tabId: pane.tabId,
      paneKey:
        isValidTerminalTabId(pane.tabId) && isTerminalLeafId(pane.leafId)
          ? makePaneKey(pane.tabId, pane.leafId)
          : null,
      recordedAtGraphSequence: Number.POSITIVE_INFINITY
    }
  }
  return {
    tabId: pty.tabId ?? null,
    paneKey: pty.paneKey ?? null,
    recordedAtGraphSequence: pty.surfaceRecordedAtGraphSequence ?? 0
  }
}
