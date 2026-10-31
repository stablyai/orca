import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../../shared/workspace-layout/terminal-pane-tree'
import { isTerminalLeafId } from '../../shared/stable-pane-id'
import { isValidHostTerminalTabId } from '../../shared/terminal-tab-id'

export type SavedTeamTab = { id: string; customTitle?: string | null; leafId?: string }

export function savedTeamTabs(
  session: Pick<WorkspaceSessionState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>,
  worktreeId: string
): SavedTeamTab[] {
  return (session.tabsByWorktree?.[worktreeId] ?? []).map((tab) => {
    const layout = session.terminalLayoutsByTabId?.[tab.id]
    const leaves = layout?.root ? collectLayoutLeafIdsInOrder(layout.root) : []
    const leafId =
      layout?.activeLeafId && leaves.includes(layout.activeLeafId) ? layout.activeLeafId : leaves[0]
    return { id: tab.id, customTitle: tab.customTitle, ...(leafId ? { leafId } : {}) }
  })
}

export function teamPaneIdentity(tab: { parentTabId: string; leafId?: string }): {
  tabId: string
  leafId: string
} {
  if (!isValidHostTerminalTabId(tab.parentTabId) || !tab.leafId || !isTerminalLeafId(tab.leafId)) {
    throw new Error('team_saved_role_layout_required')
  }
  return { tabId: tab.parentTabId, leafId: tab.leafId }
}
