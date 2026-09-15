import { ipcMain, screen, Menu, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  distributeWindowPlacements,
  readMonitorDisplays,
  recoverWindowPlacement,
  tileWindowPlacements,
  type WindowPlacement
} from './monitor-placement'
import { isBackgroundLaunch } from './foreground-activation-policy'

export function moveWorkspaceWindowToMonitor(window: BrowserWindow, displayId: number): boolean {
  const display = readMonitorDisplays(() => screen.getAllDisplays()).find(
    (entry) => entry.id === displayId
  )
  if (!display || window.isDestroyed() || window.isFullScreen()) {
    return false
  }
  const maximized = window.isMaximized()
  if (maximized && !window.isVisible()) {
    return false
  }
  const bounds = maximized ? window.getNormalBounds() : window.getBounds()
  if (maximized) {
    window.unmaximize()
  }
  window.setBounds(recoverWindowPlacement(bounds, [display]))
  if (maximized) {
    window.maximize()
  }
  return true
}

function arrangeWorkspaceWindows(
  windows: Map<number, BrowserWindow>,
  placements: readonly WindowPlacement[]
): number {
  let arranged = 0
  let placementIndex = 0
  for (const window of windows.values()) {
    if (window.isDestroyed() || window.isFullScreen()) {
      continue
    }
    const placement = placements[placementIndex]
    placementIndex += 1
    if (!placement) {
      break
    }
    if (window.isMaximized()) {
      window.unmaximize()
    }
    window.setBounds(placement)
    arranged += 1
  }
  return arranged
}

export function registerWorkspaceWindowMonitors(
  authorize: (event: IpcMainInvokeEvent) => BrowserWindow,
  windows: Map<number, BrowserWindow>
): void {
  ipcMain.handle('workspaceViews:monitors', (event) => {
    authorize(event)
    return readMonitorDisplays(() => screen.getAllDisplays()).map((display, index) => ({
      id: display.id,
      label: `Monitor ${index + 1}`
    }))
  })
  ipcMain.handle('workspaceViews:moveToMonitor', (event, id: number) =>
    moveWorkspaceWindowToMonitor(authorize(event), id)
  )
  ipcMain.handle('workspaceViews:bringWindowsToMonitor', (event) => {
    const invoker = authorize(event)
    const display = screen.getDisplayMatching(invoker.getBounds())
    for (const window of windows.values()) {
      moveWorkspaceWindowToMonitor(window, display.id)
    }
  })
  ipcMain.handle('workspaceViews:tileWindowsOnMonitor', (event) => {
    const invoker = authorize(event)
    const display = screen.getDisplayMatching(invoker.getBounds())
    const candidates = [...windows.values()].filter(
      (window) => !window.isDestroyed() && !window.isFullScreen()
    )
    return arrangeWorkspaceWindows(windows, tileWindowPlacements(display, candidates.length))
  })
  ipcMain.handle('workspaceViews:distributeWindowsAcrossMonitors', (event) => {
    authorize(event)
    const displays = readMonitorDisplays(() => screen.getAllDisplays())
    const candidates = [...windows.values()].filter(
      (window) => !window.isDestroyed() && !window.isFullScreen()
    )
    return arrangeWorkspaceWindows(windows, distributeWindowPlacements(displays, candidates.length))
  })
  ipcMain.handle('workspaceViews:showMonitorMenu', (event) => {
    const window = authorize(event)
    if (isBackgroundLaunch()) {
      return
    }
    Menu.buildFromTemplate(
      readMonitorDisplays(() => screen.getAllDisplays()).map((display, index) => ({
        label: `Monitor ${index + 1}`,
        click: () => moveWorkspaceWindowToMonitor(window, display.id)
      }))
    ).popup({ window })
  })
}
