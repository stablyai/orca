// A pane whose terminal ended, in a workspace main owns (layout-owner build): main keeps it by the
// rule the window used to apply to its own panes; any other exit retires as it always has.
import { collectLeafIds } from '../../shared/terminal-pane-layout-tree'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import {
  exitedSplitPaneOutcome,
  type ExitedSplitPaneFacts
} from './terminal/lifecycle/exited-split-pane-rule'

/**
 * Whether the rule keeps the pane (its "Terminal exited" card stays); otherwise the persistence
 * retirement removes the pane, or a last pane's tab, as it did before.
 */
export function keepsExitedPane(
  session: WorkspaceSessionState,
  surface: RetiredTerminalSurface,
  facts: ExitedSplitPaneFacts
): boolean {
  const layout = session.terminalLayoutsByTabId?.[surface.parentTabId]
  const leafIds = collectLeafIds(layout?.root)
  const paneKey = `${surface.parentTabId}:${surface.leafId}`
  const boundIncarnationId = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
  if (
    !leafIds.includes(surface.leafId) ||
    layout?.ptyIdsByLeafId?.[surface.leafId] !== surface.ptyId ||
    (surface.incarnationId && boundIncarnationId && boundIncarnationId !== surface.incarnationId)
  ) {
    return false
  }
  return exitedSplitPaneOutcome(facts, leafIds.length < 2) === 'keep'
}
