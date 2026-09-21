import type { BrowserWindow } from 'electron'
import type { WindowShortcutAction } from '../../shared/window-shortcut-policy'

export function sendResolvedWindowShortcutAction(
  mainWindow: BrowserWindow,
  action: WindowShortcutAction,
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
): void {
  switch (action.type) {
    // The renderer's DictationController re-checks enabled/sttModel and ignores hold mode, so this path needs no voice guards.
    case 'dictationKeyDown':
      mainWindow.webContents.send('ui:dictationKeyDown')
      return
    case 'zoom':
      mainWindow.webContents.send('terminal:zoom', action.direction)
      return
    case 'openSettings':
      mainWindow.webContents.send('ui:openSettings')
      return
    case 'forceReload':
      onBeforeReload?.({ ignoreCache: true, webContentsId: mainWindow.webContents.id })
      mainWindow.webContents.reloadIgnoringCache()
      return
    case 'toggleLeftSidebar':
      mainWindow.webContents.send('ui:toggleLeftSidebar')
      return
    case 'toggleRightSidebar':
      mainWindow.webContents.send('ui:toggleRightSidebar')
      return
    case 'toggleWorktreePalette':
      mainWindow.webContents.send('ui:toggleWorktreePalette')
      return
    case 'toggleFloatingTerminal':
      mainWindow.webContents.send('ui:toggleFloatingTerminal')
      return
    case 'openQuickOpen':
      mainWindow.webContents.send('ui:openQuickOpen')
      return
    case 'toggleQuickCommandsMenu':
      mainWindow.webContents.send('ui:toggleQuickCommandsMenu')
      return
    case 'openNewWorkspace':
      mainWindow.webContents.send('ui:openNewWorkspace')
      return
    case 'deleteCurrentWorkspace':
      mainWindow.webContents.send('ui:deleteCurrentWorkspace')
      return
    case 'openWorkspaceBoard':
      mainWindow.webContents.send('ui:openWorkspaceBoard')
      return
    case 'openTasks':
      mainWindow.webContents.send('ui:openTasks')
      return
    case 'toggleAgentDashboard':
      mainWindow.webContents.send('ui:toggleAgentDashboard')
      return
    case 'switchRecentTab':
      mainWindow.webContents.send('ui:switchRecentTab')
      return
    case 'jumpToWorktreeIndex':
      mainWindow.webContents.send('ui:jumpToWorktreeIndex', action.index)
      return
    case 'jumpToTabIndex':
      mainWindow.webContents.send('ui:jumpToTabIndex', action.index)
      return
    case 'worktreeHistoryNavigate':
      mainWindow.webContents.send('ui:worktreeHistoryNavigate', action.direction)
  }
}
