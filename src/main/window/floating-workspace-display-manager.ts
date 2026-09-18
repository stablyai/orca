import { type BrowserWindow, screen } from 'electron'
import {
  calculateTargetDisplayBounds,
  findNextDisplay,
  type WorkspaceDisplayInfo
} from '../../shared/floating-workspace-display'
import { isBackgroundLaunch, showWindowWithoutStealingFocus } from './foreground-activation-policy'
import {
  getPopoutCurrentDisplayId,
  installPopoutRestoreTracking,
  recordPopoutMinimize,
  resetPopoutRestoreState,
  restorePopoutWindow,
  setPopoutDisplayTarget
} from './floating-workspace-popout-restore'

export { closeIdentifyWindows, identifyDisplays } from './floating-workspace-display-identify'

let floatingWorkspacePopoutWindow: BrowserWindow | null = null

export function getFloatingWorkspacePopoutWindow(): BrowserWindow | null {
  return floatingWorkspacePopoutWindow &&
    !floatingWorkspacePopoutWindow.isDestroyed() &&
    !floatingWorkspacePopoutWindow.webContents.isDestroyed()
    ? floatingWorkspacePopoutWindow
    : null
}

export function setFloatingWorkspacePopoutWindow(window: BrowserWindow | null): void {
  floatingWorkspacePopoutWindow = window
  if (window && !window.isDestroyed()) {
    installPopoutRestoreTracking(window, getConnectedDisplays)
    // Why: the popout is created hidden (show:false); reveal it through the
    // launch policy so background/headless runs never take OS focus.
    if (typeof window.once === 'function') {
      window.once('ready-to-show', () => {
        showWindowWithoutStealingFocus(window)
      })
    }
  } else {
    resetPopoutRestoreState()
  }
}

export function closeFloatingWorkspacePopout(): void {
  if (floatingWorkspacePopoutWindow && !floatingWorkspacePopoutWindow.isDestroyed()) {
    floatingWorkspacePopoutWindow.close()
  }
  floatingWorkspacePopoutWindow = null
  resetPopoutRestoreState()
}

export function minimizeFloatingWorkspacePopout(): boolean {
  const win = getFloatingWorkspacePopoutWindow()
  if (win && !win.isDestroyed()) {
    recordPopoutMinimize(win)
    if (typeof win.minimize === 'function') {
      win.minimize()
    }
    return true
  }
  return false
}

export function restoreFloatingWorkspacePopout(): boolean {
  const win = getFloatingWorkspacePopoutWindow()
  if (win && !win.isDestroyed()) {
    return restorePopoutWindow(win, getConnectedDisplays())
  }
  return false
}

export function isFloatingWorkspacePopoutMinimized(): boolean {
  const win = getFloatingWorkspacePopoutWindow()
  if (win && !win.isDestroyed()) {
    return typeof win.isMinimized === 'function' ? win.isMinimized() : false
  }
  return false
}

export function focusFloatingWorkspacePopout(): boolean {
  const win = getFloatingWorkspacePopoutWindow()
  if (win && !win.isDestroyed()) {
    const isMin = typeof win.isMinimized === 'function' ? win.isMinimized() : false
    if (isMin) {
      restoreFloatingWorkspacePopout()
    } else if (!isBackgroundLaunch() && typeof win.focus === 'function') {
      win.focus()
    }
    return true
  }
  return false
}

export function getCurrentDisplayId(): number | null {
  const win = getFloatingWorkspacePopoutWindow()
  if (win && !win.isDestroyed()) {
    return getPopoutCurrentDisplayId(win)
  }
  return null
}

export function getConnectedDisplays(): WorkspaceDisplayInfo[] {
  try {
    const primary = screen.getPrimaryDisplay()
    return screen.getAllDisplays().map((d, index) => {
      const displayNumber = index + 1
      const isPrimary = d.id === primary.id
      // Why: primary status travels as the isPrimary flag so each surface renders its own marker.
      const label = d.label || `Monitor ${displayNumber}`
      return {
        id: d.id,
        label,
        bounds: { ...d.bounds },
        workArea: { ...d.workArea },
        isPrimary,
        scaleFactor: d.scaleFactor
      }
    })
  } catch (err) {
    console.warn('[floating-workspace] Failed to get displays:', err)
    return []
  }
}

export function moveWindowToDisplay(window: BrowserWindow, targetDisplayId: number): boolean {
  if (window.isDestroyed() || !Number.isInteger(targetDisplayId)) {
    return false
  }
  const displays = getConnectedDisplays()
  const target = displays.find((d) => d.id === targetDisplayId)
  if (!target) {
    return false
  }
  const isMax = typeof window.isMaximized === 'function' ? window.isMaximized() : false
  if (isMax && typeof window.unmaximize === 'function') {
    window.unmaximize()
  }
  const currentBounds = typeof window.getBounds === 'function' ? window.getBounds() : undefined
  const newBounds = calculateTargetDisplayBounds(target, { currentBounds })
  setPopoutDisplayTarget(target.id, newBounds, isMax)
  if (typeof window.setBounds === 'function') {
    window.setBounds(newBounds)
  }
  if (isMax && typeof window.maximize === 'function') {
    window.maximize()
  }
  return true
}

export function moveWindowToNextDisplay(window: BrowserWindow): boolean {
  if (window.isDestroyed()) {
    return false
  }
  const displays = getConnectedDisplays()
  if (displays.length <= 1) {
    return false
  }
  const currentBounds = typeof window.getBounds === 'function' ? window.getBounds() : undefined
  if (!currentBounds) {
    return false
  }
  let currentDisplayId: number
  try {
    currentDisplayId = screen.getDisplayMatching(currentBounds).id
  } catch {
    return false
  }
  const nextDisplay = findNextDisplay(displays, currentDisplayId)
  if (!nextDisplay) {
    return false
  }
  return moveWindowToDisplay(window, nextDisplay.id)
}
