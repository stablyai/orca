import { RuntimeHeadlessTabGroups } from './headless-tab-group-moves'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
export abstract class RuntimeHeadlessTerminalTabTitles extends RuntimeHeadlessTabGroups {
  // Persist a manual terminal rename so a headless rebuild keeps the title
  // instead of reverting to the generated/default one.
  protected persistHeadlessTerminalTitle(
    worktreeId: string,
    tabId: string,
    title: string | null
  ): void {
    this.updateHeadlessWorkspaceContent(worktreeId, (session) => {
      const tabs = session.tabsByWorktree[worktreeId]
      if (!tabs?.some((tab) => tab.id === tabId)) {
        return null
      }
      return {
        ...session,
        tabsByWorktree: {
          ...session.tabsByWorktree,
          [worktreeId]: tabs.map((tab) => (tab.id === tabId ? { ...tab, customTitle: title } : tab))
        }
      }
    })
  }

  private updateHeadlessWorkspaceContent(
    worktreeId: string,
    update: (session: WorkspaceSessionState) => WorkspaceSessionState | null
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const write = this.setWorkspaceSessionForWorktree.bind(this)
    const next = update(session)
    if (next) {
      write(worktreeId, next)
    }
  }
}
