// Layout-owner builds: a close by a terminal's handle, for a pane main owns, is main's own layout
// close. Main finds the pane in its layout, closes it there (recorded, so a late start is refused)
// and stops the terminals the close ends; no window or phone row takes part.

import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../runtime-layout-apply'
import { startedMainTerminalSurfaces } from '../terminal/surface/main-terminal-surfaces'
import { NO_STOP, type ExplicitCloseStop } from './explicit-terminal-close-pty-stops'

type HandleTarget = { worktreeId: string; ptyId: string | null; tabId?: string; leafId?: string }

export type MainHandleCloseHost = {
  runtime: object
  /** The handle's live terminal, when it names one. */
  livePty: () => { ptyId: string; worktreeId: string } | null
  /** The handle's pane in the runtime graph; throws as a stale handle does. */
  liveLeaf: () => { worktreeId: string; tabId: string; leafId: string; ptyId: string | null }
  applyLayoutCommand: (command: WindowLayoutCommand) => Promise<LayoutApplyReply>
  stop: (ptyIds: string[], addressedPtyId: string) => Promise<ExplicitCloseStop>
  describe: (
    handle: string,
    tabId: string,
    ptyId: string | null,
    stop: ExplicitCloseStop
  ) => RuntimeTerminalClose
}

/**
 * Closes the pane (or, with `wholeTab` or for a tab's last pane, the tab) the handle names in
 * main's layout. Null for a workspace main does not own, and for a pane close of a terminal in
 * no pane: today's close path answers those.
 */
export async function closeMainOwnedPaneByHandle(
  host: MainHandleCloseHost,
  handle: string,
  wholeTab: boolean
): Promise<RuntimeTerminalClose | null> {
  const surfaces = startedMainTerminalSurfaces(host.runtime)
  if (!surfaces) {
    return null
  }
  // The graph takes main's latest panes first, so a handle names what main holds now.
  surfaces.republish()
  const target: HandleTarget = host.livePty() ?? host.liveLeaf()
  if (!surfaces.ownsWorkspace(target.worktreeId)) {
    return null
  }
  const pane =
    target.tabId && target.leafId
      ? { tabId: target.tabId, leafId: target.leafId }
      : target.ptyId
        ? surfaces.findPaneForPty(target.ptyId)
        : null
  const panes = pane ? surfaces.panesOfTab(pane.tabId) : []
  if (!pane || !panes.some((entry) => entry.leafId === pane.leafId)) {
    // A terminal in no pane of main's layout has no tab to close; a pane close still stops it.
    if (wholeTab || !target.ptyId) {
      throw new Error('terminal_handle_stale')
    }
    return null
  }
  const closesTab = wholeTab || panes.length <= 1
  const reply = await host.applyLayoutCommand(
    closesTab
      ? {
          type: 'closeTabs',
          workspace: target.worktreeId,
          tabIds: [pane.tabId],
          recordClose: 'user'
        }
      : { type: 'closePane', workspace: target.worktreeId, tabId: pane.tabId, leafId: pane.leafId }
  )
  if (!reply.ok) {
    // A refusal changed nothing: a deliberate freeze, or a pane a concurrent close already took.
    throw new Error(
      reply.code === 'tab_not_found' || reply.code === 'pane_not_found'
        ? 'terminal_handle_stale'
        : reply.code
    )
  }
  const ended = closesTab
    ? panes.flatMap((entry) => (entry.ptyId ? [entry.ptyId] : []))
    : target.ptyId
      ? [target.ptyId]
      : []
  // Main's tab close stops nothing itself: every terminal it ends stops here, addressed or not.
  const addressed = target.ptyId ?? ended[0]
  const stop = addressed ? await host.stop(ended, addressed) : NO_STOP
  const addressedStop = target.ptyId ? stop : NO_STOP
  return wholeTab
    ? { handle, tabId: pane.tabId, closeMode: 'tab', ptyKilled: false }
    : host.describe(handle, pane.tabId, target.ptyId, addressedStop)
}
