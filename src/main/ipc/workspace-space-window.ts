import { BrowserWindow, ipcMain } from 'electron'
import { getTrustedUIRendererWebContents, isTrustedUIRenderer } from './ui'
import {
  closeWorkspaceSpaceWindow,
  createOrFocusWorkspaceSpaceWindow,
  getWorkspaceSpaceWindow,
  isWorkspaceSpaceWindowRenderer
} from '../window/workspace-space-window'
import { safelyRevealWindow } from '../window/focus-existing-window'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import type { Store } from '../persistence'

export function registerWorkspaceSpaceWindowHandlers(store: Store): void {
  for (const channel of [
    'workspaceSpace:openWindow',
    'workspaceSpace:closeWindow',
    'workspaceSpace:publishWindowState',
    'workspaceSpace:requestWindowState',
    'workspaceSpace:revealWorktree',
    'workspaceSpace:requestWorktreeRefresh',
    'workspaceSpace:publishWindowAnalysis'
  ]) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle('workspaceSpace:openWindow', (event): void => {
    if (isTrustedUIRenderer(event.sender)) {
      createOrFocusWorkspaceSpaceWindow(store)
    }
  })
  ipcMain.handle('workspaceSpace:closeWindow', (event): void => {
    if (isWorkspaceSpaceWindowRenderer(event.sender)) {
      closeWorkspaceSpaceWindow()
    }
  })
  ipcMain.handle('workspaceSpace:publishWindowState', (event, state: unknown): void => {
    if (isTrustedUIRenderer(event.sender)) {
      getWorkspaceSpaceWindow()?.webContents.send('workspaceSpace:windowState', state)
    }
  })
  ipcMain.handle('workspaceSpace:requestWindowState', (event): void => {
    if (isWorkspaceSpaceWindowRenderer(event.sender)) {
      getTrustedUIRendererWebContents()?.send('workspaceSpace:windowStateRequested')
    }
  })
  ipcMain.handle(
    'workspaceSpace:revealWorktree',
    (event, worktreeId: unknown, hostId: unknown): void => {
      if (!isWorkspaceSpaceWindowRenderer(event.sender) || typeof worktreeId !== 'string') {
        return
      }
      if (hostId !== undefined && typeof hostId !== 'string') {
        return
      }
      const executionHostId = normalizeExecutionHostId(hostId)
      if (hostId !== undefined && executionHostId === null) {
        return
      }
      const main = getTrustedUIRendererWebContents()
      if (!main) {
        return
      }
      if (!isBackgroundLaunch()) {
        const window = BrowserWindow.fromWebContents(main)
        if (window) {
          safelyRevealWindow(window)
        }
      }
      main.send('workspaceSpace:revealWorktree', worktreeId, executionHostId ?? undefined)
    }
  )
  ipcMain.handle('workspaceSpace:requestWorktreeRefresh', (event): void => {
    if (isWorkspaceSpaceWindowRenderer(event.sender)) {
      getTrustedUIRendererWebContents()?.send('workspaceSpace:worktreeRefreshRequested')
    }
  })
  ipcMain.handle('workspaceSpace:publishWindowAnalysis', (event, analysis: unknown): void => {
    if (isWorkspaceSpaceWindowRenderer(event.sender) && analysis && typeof analysis === 'object') {
      getTrustedUIRendererWebContents()?.send('workspaceSpace:windowAnalysis', analysis)
    }
  })
}
