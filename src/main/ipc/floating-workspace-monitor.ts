import { ipcMain, screen } from 'electron'
import {
  getConnectedDisplays,
  getCurrentDisplayId,
  getFloatingWorkspacePopoutWindow,
  identifyDisplays,
  isFloatingWorkspacePopoutMinimized,
  minimizeFloatingWorkspacePopout,
  moveWindowToDisplay,
  moveWindowToNextDisplay
} from '../window/floating-workspace-display-manager'
import { isTrustedUIRenderer, sendToTrustedUIRenderer } from './ui'

export function registerFloatingWorkspaceMonitorHandlers(): void {
  ipcMain.removeHandler('floatingWorkspace:getDisplays')
  ipcMain.removeHandler('floatingWorkspace:getCurrentDisplayId')
  ipcMain.removeHandler('floatingWorkspace:moveToDisplay')
  ipcMain.removeHandler('floatingWorkspace:moveToNextDisplay')
  ipcMain.removeHandler('floatingWorkspace:identifyDisplays')
  ipcMain.removeHandler('floatingWorkspace:minimize')
  ipcMain.removeHandler('floatingWorkspace:isMinimized')

  ipcMain.handle('floatingWorkspace:getDisplays', (event) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return []
    }
    return getConnectedDisplays()
  })

  ipcMain.handle('floatingWorkspace:getCurrentDisplayId', (event) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return null
    }
    return getCurrentDisplayId()
  })

  ipcMain.handle('floatingWorkspace:moveToDisplay', (event, displayId: unknown) => {
    if (
      !isTrustedUIRenderer(event.sender) ||
      typeof displayId !== 'number' ||
      !Number.isInteger(displayId)
    ) {
      return false
    }
    const popout = getFloatingWorkspacePopoutWindow()
    if (!popout) {
      return false
    }
    return moveWindowToDisplay(popout, displayId)
  })

  ipcMain.handle('floatingWorkspace:moveToNextDisplay', (event) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return false
    }
    const popout = getFloatingWorkspacePopoutWindow()
    if (!popout) {
      return false
    }
    return moveWindowToNextDisplay(popout)
  })

  ipcMain.handle('floatingWorkspace:identifyDisplays', (event) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return false
    }
    return identifyDisplays()
  })

  ipcMain.handle('floatingWorkspace:minimize', (event) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return false
    }
    return minimizeFloatingWorkspacePopout()
  })

  ipcMain.handle('floatingWorkspace:isMinimized', (event) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return false
    }
    return isFloatingWorkspacePopoutMinimized()
  })

  // Why removeListener first: register runs again on every core-handler setup, so re-adding blindly would fan out one broadcast per setup.
  if (typeof screen?.on === 'function') {
    if (typeof screen.removeListener === 'function') {
      screen.removeListener('display-added', broadcastDisplaysChanged)
      screen.removeListener('display-removed', broadcastDisplaysChanged)
      screen.removeListener('display-metrics-changed', broadcastDisplaysChanged)
    }
    screen.on('display-added', broadcastDisplaysChanged)
    screen.on('display-removed', broadcastDisplaysChanged)
    screen.on('display-metrics-changed', broadcastDisplaysChanged)
  }
}

export function broadcastDisplaysChanged(): void {
  const displays = getConnectedDisplays()
  sendToTrustedUIRenderer('floatingWorkspace:displaysChanged', displays)
}
