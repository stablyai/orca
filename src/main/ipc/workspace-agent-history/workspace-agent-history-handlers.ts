import { ipcMain } from 'electron'
import {
  configureWorkspaceAgentHistory,
  deleteAgentHistoryForRemovedWorkspace,
  deleteDeletedWorkspaceAgentHistory,
  measureDeletedWorkspaceAgentHistory,
  type WorkspaceAgentHistoryStore
} from '../../workspace-agent-history/workspace-agent-history'
import type { RuntimeWorktreeLifecycleEvent } from '../../runtime/workspaces/lifecycle/worktree-lifecycle-event'

export function registerWorkspaceAgentHistoryHandlers(
  store: WorkspaceAgentHistoryStore,
  runtime: {
    onWorktreeLifecycle: (listener: (event: RuntimeWorktreeLifecycleEvent) => void) => () => void
  },
  ensureChatHost: () => Promise<unknown>
): void {
  configureWorkspaceAgentHistory({ store, ensureChatHost })
  runtime.onWorktreeLifecycle(deleteAgentHistoryForRemovedWorkspace)
  ipcMain.handle('aiVault:measureDeletedWorkspaceHistory', () =>
    measureDeletedWorkspaceAgentHistory()
  )
  ipcMain.handle('aiVault:deleteDeletedWorkspaceHistory', (_event, planId: unknown) => {
    if (typeof planId !== 'string') {
      throw new Error('A measurement is required before deleting.')
    }
    return deleteDeletedWorkspaceAgentHistory(planId)
  })
}
