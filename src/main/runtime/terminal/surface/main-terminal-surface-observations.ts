import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  startedMainTerminalSurfaces,
  type MainPaneRecordFacts,
  type SurfacesOwner
} from './main-terminal-surfaces'

/** After record updates, recompose bound panes when connection, incarnation or workspace changed; unchanged refreshes do nothing. */
export function noteMainPaneRecordChange(
  runtime: SurfacesOwner,
  prior: MainPaneRecordFacts | undefined,
  next: MainPaneRecordFacts & { ptyId: string }
): void {
  if (
    prior &&
    prior.connected === next.connected &&
    prior.incarnationId === next.incarnationId &&
    prior.worktreeId === next.worktreeId
  ) {
    return
  }
  const surfaces = startedMainTerminalSurfaces(runtime)
  if (surfaces?.bindsTerminal(next.ptyId)) {
    surfaces.terminalChanged()
  }
}

/** Whether main's layout still holds the pane; null before main has published its panes. */
export function mainLayoutHoldsPane(runtime: SurfacesOwner, paneKey: string): boolean | null {
  const surfaces = startedMainTerminalSurfaces(runtime)
  const pane = parsePaneKey(paneKey)
  return surfaces && pane ? surfaces.paneOf(pane.tabId, pane.leafId) !== null : null
}

/** Whether another pane still holds an agent session: a terminal of it that has not exited, or no
 *  terminal at all, which switch-on holds only while main's layout still holds the pane. */
export function paneHoldsSession(
  runtime: SurfacesOwner,
  paneKey: string,
  panePtyIds: readonly string[],
  exited: (ptyId: string) => boolean
): boolean {
  if (panePtyIds.length > 0) {
    return panePtyIds.some((ptyId) => !exited(ptyId))
  }
  return !ORCA_LAYOUT_OWNER_IS_MAIN || mainLayoutHoldsPane(runtime, paneKey) !== false
}

/** Main-owned pane existence cannot prove process life; inventory/records decide. Paired-runtime workspaces retain window rules. */
export function mainDecidesLeafLiveness(runtime: SurfacesOwner, worktreeId: string): boolean {
  return ORCA_LAYOUT_OWNER_IS_MAIN && mainListsEveryPane(runtime, worktreeId)
}

/** Whether main lists the workspace's panes, so terminal.list shows every saved one. */
export function mainListsEveryPane(runtime: SurfacesOwner, worktreeId: string): boolean {
  return startedMainTerminalSurfaces(runtime)?.ownsWorkspace(worktreeId) === true
}

/** Include all main-bound terminals in worktree stops, even saved SSH ids not yet re-registered after restart. */
export function withMainBoundLeaves(
  runtime: SurfacesOwner,
  leaves: Iterable<{ worktreeId: string; ptyId: string | null }>
): { worktreeId: string; ptyId: string | null }[] {
  return [...leaves, ...(startedMainTerminalSurfaces(runtime)?.boundLeaves() ?? [])]
}

/** The facts of a record before an update; undefined for a record not yet made. */
export function mainPaneRecordFacts(
  record: MainPaneRecordFacts | undefined
): MainPaneRecordFacts | undefined {
  return (
    record && {
      connected: record.connected,
      incarnationId: record.incarnationId,
      worktreeId: record.worktreeId
    }
  )
}
