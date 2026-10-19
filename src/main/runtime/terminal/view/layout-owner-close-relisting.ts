import type {
  RuntimePtyTabCloseAuthority,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { terminalLayoutContainsLeaf } from '../../../../shared/workspace-session-pane-ownership'
import type { ExecutionHostId } from '../../../../shared/execution-host'

type RelistedPane = {
  tabId: string
  leafId: string
  title: null
  activate: false
  selectIfNoActiveTab: false
  /** The close's own record: clients keep the window's list, which catches up on its own. */
  notify: false
}

/**
 * Layout-owner builds: the pane main's own layout binds this close's terminal to, when the window's
 * list lacks it. That list lags main (a split written, not yet drawn or bound), and a close by the
 * terminal's handle must not depend on it.
 */
export function relistPaneMainBinds(
  authority: RuntimePtyTabCloseAuthority,
  pty: RuntimePtyWorktreeRecord | undefined,
  host: {
    hostId: (tabId: string) => ExecutionHostId | undefined
    session: (hostId: ExecutionHostId) => WorkspaceSessionState | null | undefined
    relist: (pty: RuntimePtyWorktreeRecord, pane: RelistedPane) => void
  }
): void {
  if (
    !pty?.connected ||
    pty.ptyId !== authority.ptyId ||
    pty.incarnationId !== authority.incarnationId ||
    pty.worktreeId !== authority.worktreeId
  ) {
    return
  }
  const pane = parsePaneKey(pty.paneKey ?? '')
  const hostId = pane && pane.tabId === pty.tabId ? host.hostId(pane.tabId) : undefined
  if (!pane || !hostId) {
    return
  }
  const session = host.session(hostId)
  const layout = session?.terminalLayoutsByTabId?.[pane.tabId]
  const incarnationId =
    session?.terminalPtyIncarnationsByPaneKey?.[makePaneKey(pane.tabId, pane.leafId)]
  if (
    layout?.ptyIdsByLeafId?.[pane.leafId] !== pty.ptyId ||
    !terminalLayoutContainsLeaf(layout.root, pane.leafId) ||
    (incarnationId && incarnationId !== pty.incarnationId)
  ) {
    return
  }
  host.relist(pty, {
    tabId: pane.tabId,
    leafId: pane.leafId,
    title: null,
    activate: false,
    selectIfNoActiveTab: false,
    notify: false
  })
}
