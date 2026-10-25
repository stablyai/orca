// Close removes the pane before exit; resolve it by PTY and incarnation in closed-pane records, then retire that entry (L80 Q2).
import { closedTerminalPaneOf } from '../../../../shared/closed-terminal-panes'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { worktreeIdsEqual } from '../../../../shared/worktree/id'

export type ClosedPaneOfExit = {
  tabId: string
  paneKey: string
  ptyId: string
  incarnationId: string
}

export function closedPaneOfExitedPty(
  store: RuntimeStore | null | undefined,
  hostId: ExecutionHostId | null,
  pty: { ptyId: string; worktreeId: string },
  incarnationId: string | null | undefined
): ClosedPaneOfExit | null {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || !incarnationId || !store?.getWorkspaceSession) {
    return null
  }
  const session = store.getWorkspaceSession(hostId ?? undefined)
  const pane = closedTerminalPaneOf(session?.closedTerminalPanesByPaneKey, pty.ptyId, incarnationId)
  const separator = pane?.paneKey.lastIndexOf(':') ?? -1
  if (!pane || separator < 1 || !worktreeIdsEqual(pane.worktreeId, pty.worktreeId)) {
    return null
  }
  return {
    tabId: pane.paneKey.slice(0, separator),
    paneKey: pane.paneKey,
    ptyId: pty.ptyId,
    incarnationId
  }
}

/** The session without the exit's closed-pane entry; unchanged unless the entry still names it. */
export function forgetClosedPaneOfExit(
  session: WorkspaceSessionState,
  closed: ClosedPaneOfExit
): WorkspaceSessionState {
  const entry = session.closedTerminalPanesByPaneKey?.[closed.paneKey]
  if (entry?.ptyId !== closed.ptyId || entry.incarnationId !== closed.incarnationId) {
    return session
  }
  const remaining = { ...session.closedTerminalPanesByPaneKey }
  delete remaining[closed.paneKey]
  return { ...session, closedTerminalPanesByPaneKey: remaining }
}
