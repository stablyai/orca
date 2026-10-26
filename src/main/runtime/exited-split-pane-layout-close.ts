import { collectLeafIds } from '../../shared/terminal-pane-layout-tree'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import {
  exitedSplitPaneOutcome,
  type ExitedSplitPaneFacts
} from './terminal/lifecycle/exited-split-pane-rule'

/** Keep the Terminal exited card where policy requires it; otherwise retire the pane or its empty tab. */
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
