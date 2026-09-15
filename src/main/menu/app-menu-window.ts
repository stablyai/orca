import { translateMain } from '../i18n/main-i18n'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, screen } from 'electron'
import { readMonitorDisplays } from '../window/monitor-placement'
import { moveWorkspaceWindowToMonitor } from '../window/workspace-window-monitors'
import type { WorkspaceViewCommand } from '../../shared/workspace-view-bridge'

function sendLayoutAction(
  window: Electron.BaseWindow | undefined,
  operation: WorkspaceViewCommand
): void {
  const target =
    window && 'webContents' in window ? (window as BrowserWindow) : BrowserWindow.getFocusedWindow()
  target?.webContents.send('workspaceViews:request', randomUUID(), operation, {})
}

export function createWindowMenu(onNewWindow?: () => void): Electron.MenuItemConstructorOptions {
  return {
    label: translateMain('menu.window', 'Window'),
    submenu: [
      {
        label: translateMain('menu.newWindow', 'New Window'),
        accelerator: 'CmdOrCtrl+Shift+N',
        click: () => onNewWindow?.()
      },
      { type: 'separator' },
      {
        label: 'Undo Layout Change',
        click: (_item, window) => sendLayoutAction(window, 'undo-layout')
      },
      {
        label: 'Reopen Closed View',
        click: (_item, window) => sendLayoutAction(window, 'reopen-view')
      },
      {
        label: 'Move to Monitor',
        submenu: readMonitorDisplays(() => screen.getAllDisplays()).map((display, index) => ({
          label: `Monitor ${index + 1}`,
          click: (_item, window) => {
            const target =
              window && 'webContents' in window
                ? (window as BrowserWindow)
                : BrowserWindow.getFocusedWindow()
            if (target) {
              moveWorkspaceWindowToMonitor(target, display.id)
            }
          }
        }))
      },
      {
        label: 'Bring All Windows to This Monitor',
        click: (_item, window) => sendLayoutAction(window, 'bring-monitor')
      },
      { type: 'separator' },
      { role: 'minimize' },
      { role: 'zoom' }
    ]
  }
}
