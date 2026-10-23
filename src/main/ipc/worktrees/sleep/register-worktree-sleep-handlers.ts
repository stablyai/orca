import { ipcMain } from 'electron'
import type { WorkspaceSleepRequest } from '../../../../shared/workspace-sleep'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import type { RestoredPane } from '../../../runtime/terminal/recovery/restored-pane-start'

function isRestoredPane(value: unknown): value is RestoredPane {
  return (
    typeof value === 'object' &&
    value !== null &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'tabId' in value &&
    typeof value.tabId === 'string' &&
    'leafId' in value &&
    typeof value.leafId === 'string'
  )
}

/** The window's Sleep: main runs it on each workspace's hosts and the window follows its notices. */
export function registerWorktreeSleepHandlers(context: WorktreeIpcContext): void {
  ipcMain.handle('worktrees:sleep', (_event, request: WorkspaceSleepRequest) =>
    context.runtime.sleepWorkspaces(request)
  )
  // The user opened a workspace whose sleep is still running: its VM keeps running.
  ipcMain.handle('worktrees:sleepReopened', (_event, worktreeId: string) =>
    context.runtime.noteWorkspaceReopened(worktreeId)
  )
  // The window opened a slept pane: main resumes it, and the window's spawn attaches to it.
  ipcMain.handle('worktrees:resumeSleptPane', (_event, pane: unknown) => {
    if (!isRestoredPane(pane)) {
      throw new Error('invalid_pane')
    }
    return context.runtime.resumeSleptPane(pane)
  })
}
