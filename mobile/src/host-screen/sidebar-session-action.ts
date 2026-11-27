import { translate } from '../i18n/mobile-i18n'
import { agentDisplayLabel } from '../worktree/agent-lineage/agent-row-display'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import { getSelectedSidebarSession, setSelectedSidebarSession } from './selected-sidebar-session'

export type SidebarSessionAction = {
  worktree: Worktree
  paneKey: string
  label: string
}

export function sidebarSessionAction(
  worktree: Worktree,
  paneKey: string,
  now: number
): SidebarSessionAction {
  const row = worktree.agents?.find((agent) => agent.paneKey === paneKey)
  return {
    worktree,
    paneKey,
    label: row ? agentDisplayLabel(row, now, translate) : worktree.displayName || worktree.repo
  }
}

export function clearClosedSidebarSession(session: SidebarSessionAction): void {
  const current = getSelectedSidebarSession()
  if (current?.worktreeId === session.worktree.worktreeId && current.paneKey === session.paneKey) {
    setSelectedSidebarSession(null)
  }
}
