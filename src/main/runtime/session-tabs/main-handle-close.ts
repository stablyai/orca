// Main-owned handle close commits pane/tab retirement before stopping ended terminals; no window or phone row is required.

import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WindowLayoutCommand } from '../runtime-layout-apply'
import { startedMainTerminalSurfaces } from '../terminal/surface/main-terminal-surfaces'
import type { ExplicitCloseStop } from './explicit-terminal-close-pty-stops'
import { closeInMainLayout } from './main-layout-close-command'

type HandleTarget = { worktreeId: string; ptyId: string | null; tabId?: string; leafId?: string }

export type MainHandleCloseHost = {
  runtime: object
  /** The handle's live terminal, when it names one. */
  livePty: () => { ptyId: string; worktreeId: string } | null
  /** The handle's pane in the runtime graph; throws as a stale handle does. */
  liveLeaf: () => { worktreeId: string; tabId: string; leafId: string; ptyId: string | null }
  applyLayoutCommand: (command: WindowLayoutCommand) => Promise<LayoutApplyReply>
  /** The tab's dormant SSH relay session, which a tab close also ends. */
  remoteSessionIdOf: (worktreeId: string, tabId: string) => string | undefined
  stop: (ptyIds: string[], addressedPtyId: string) => Promise<ExplicitCloseStop>
  describe: (
    handle: string,
    tabId: string,
    ptyId: string | null,
    stop: ExplicitCloseStop
  ) => RuntimeTerminalClose
}

/** Close the handle's pane or whole/last-pane tab in main layout; null falls back for unowned workspaces or paneless pane closes. */
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
  const close = pane
    ? await closeInMainLayout(
        {
          panesOfTab: (tabId) => surfaces.panesOfTab(tabId),
          applyLayoutCommand: host.applyLayoutCommand,
          remoteSessionIdOf: (tabId) => host.remoteSessionIdOf(target.worktreeId, tabId),
          stop: host.stop
        },
        {
          worktreeId: target.worktreeId,
          tabId: pane.tabId,
          leafId: pane.leafId,
          wholeTab,
          addressedPtyId: target.ptyId,
          stopEnded: true
        }
      )
    : null
  if (!pane || !close) {
    // A terminal in no pane of main's layout has no tab to close; a pane close still stops it.
    if (wholeTab || !target.ptyId) {
      throw new Error('terminal_handle_stale')
    }
    return null
  }
  // A pane a concurrent close already took is a stale handle.
  if (close.outcome === 'gone') {
    throw new Error('terminal_handle_stale')
  }
  return wholeTab
    ? { handle, tabId: pane.tabId, closeMode: 'tab', ptyKilled: false }
    : host.describe(handle, pane.tabId, target.ptyId, close.addressedStop)
}
