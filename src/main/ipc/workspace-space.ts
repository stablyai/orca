import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { WorkspaceSpaceAnalysis } from '../../shared/workspace-space-types'
import { analyzeWorkspaceSpace } from '../workspace-space-analysis'

export function registerWorkspaceSpaceHandlers(store: Store): void {
  let inFlightScan: Promise<WorkspaceSpaceAnalysis> | null = null
  ipcMain.removeHandler('workspaceSpace:analyze')
  ipcMain.handle('workspaceSpace:analyze', async (): Promise<WorkspaceSpaceAnalysis> => {
    if (!inFlightScan) {
      // Why: large worktree fleets require real disk traversal; duplicate
      // requests should share that IO instead of starting competing scans.
      inFlightScan = analyzeWorkspaceSpace(store).finally(() => {
        inFlightScan = null
      })
    }
    return inFlightScan
  })
}
