import { BrowserWindow, ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { getTrustedUIRendererWebContents, isTrustedUIRenderer } from '../ui'
import {
  createOrFocusWorkspaceSpaceWindow,
  getWorkspaceSpaceWindow,
  isWorkspaceSpaceWindowRenderer
} from '../../window/workspace-space-window'
import { safelyRevealWindow } from '../../window/activation/focus-existing-window'
import { isBackgroundLaunch } from '../../window/activation/foreground-activation-policy'
import { normalizeExecutionHostId } from '../../../shared/execution-host/execution-host'
import { isWorkspaceSpaceChange } from '../../../shared/workspace-disk-space/workspace-space-change'
import type { Store } from '../../persistence/loading-store/store'
import { createStoreNativeSettingsProjection } from '../../core-desktop/native-settings-projection'

export function registerWorkspaceSpaceWindowHandlers(
  store: Store,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  const nativeSettings = createStoreNativeSettingsProjection(store)
  if (ipc === ipcMain) {
    for (const channel of [
      'workspaceSpace:openWindow',
      'workspaceSpace:publishWindowState',
      'workspaceSpace:requestWindowState',
      'workspaceSpace:revealWorktree',
      'workspaceSpace:requestWorktreeRefresh',
      'workspaceSpace:requestIssueRefresh',
      'workspaceSpace:publishWindowAnalysis'
    ]) {
      ipcMain.removeHandler(channel)
    }
  }

  ipc.handle('workspaceSpace:openWindow', (event): void => {
    if (isTrustedUIRenderer(event.sender)) {
      createOrFocusWorkspaceSpaceWindow(nativeSettings)
    }
  })
  ipc.handle('workspaceSpace:publishWindowState', (event, state: unknown): void => {
    if (isTrustedUIRenderer(event.sender)) {
      getWorkspaceSpaceWindow()?.webContents.send('workspaceSpace:windowState', state)
    }
  })
  ipc.handle('workspaceSpace:requestWindowState', (event): void => {
    if (isWorkspaceSpaceWindowRenderer(event.sender)) {
      getTrustedUIRendererWebContents()?.send('workspaceSpace:windowStateRequested')
    }
  })
  ipc.handle(
    'workspaceSpace:revealWorktree',
    (event, worktreeId: unknown, hostId: unknown, change: unknown): void => {
      if (!isWorkspaceSpaceWindowRenderer(event.sender) || typeof worktreeId !== 'string') {
        return
      }
      if (hostId !== undefined && typeof hostId !== 'string') {
        return
      }
      if (change !== undefined && !isWorkspaceSpaceChange(change)) {
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
      main.send('workspaceSpace:revealWorktree', worktreeId, executionHostId ?? undefined, change)
    }
  )
  ipc.handle('workspaceSpace:requestWorktreeRefresh', (event): void => {
    if (isWorkspaceSpaceWindowRenderer(event.sender)) {
      getTrustedUIRendererWebContents()?.send('workspaceSpace:worktreeRefreshRequested')
    }
  })
  // Why: the main window owns issueCache and publishes it to the Space window; Space asks rather than writing its own copy.
  ipc.handle(
    'workspaceSpace:requestIssueRefresh',
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
      getTrustedUIRendererWebContents()?.send(
        'workspaceSpace:issueRefreshRequested',
        worktreeId,
        executionHostId ?? undefined
      )
    }
  )
  ipc.handle('workspaceSpace:publishWindowAnalysis', (event, analysis: unknown): void => {
    if (isWorkspaceSpaceWindowRenderer(event.sender) && analysis && typeof analysis === 'object') {
      getTrustedUIRendererWebContents()?.send('workspaceSpace:windowAnalysis', analysis)
    }
  })
}
