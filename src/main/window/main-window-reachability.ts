import { screen, type BrowserWindow, type Rectangle } from 'electron'
import { deferAppKitSceneMutation } from '../appkit-scene-mutation'
import { TITLEBAR_CSS_CENTER } from './main-window-visual-lifecycle'

const pendingRecoveries = new WeakSet<BrowserWindow>()
const MIN_REACHABLE_TITLEBAR_WIDTH = 60
const MIN_REACHABLE_TITLEBAR_HEIGHT = 16

export function mainWindowBoundsHaveReachableTitlebar(bounds: Rectangle): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) {
    return false
  }
  const titlebarHeight = Math.min(bounds.height, TITLEBAR_CSS_CENTER * 2)
  try {
    return screen.getAllDisplays().some((display) => {
      const area = display.workArea
      const visibleWidth = Math.max(
        0,
        Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
      )
      const visibleTitlebarHeight = Math.max(
        0,
        Math.min(bounds.y + titlebarHeight, area.y + area.height) - Math.max(bounds.y, area.y)
      )
      return (
        visibleWidth >= Math.min(MIN_REACHABLE_TITLEBAR_WIDTH, bounds.width) &&
        visibleTitlebarHeight >= Math.min(MIN_REACHABLE_TITLEBAR_HEIGHT, titlebarHeight)
      )
    })
  } catch {
    return false
  }
}

function hasReachableTitlebar(window: BrowserWindow): boolean {
  return mainWindowBoundsHaveReachableTitlebar(window.getBounds())
}

function getRecoveryWorkArea(bounds: Rectangle): Rectangle {
  try {
    return screen.getDisplayMatching(bounds).workArea
  } catch {
    return screen.getPrimaryDisplay().workArea
  }
}

export function isMainWindowReachable(window: BrowserWindow): boolean {
  if (window.isDestroyed()) {
    return false
  }
  try {
    if (window.isFullScreen() || window.isMaximized()) {
      return true
    }
    return hasReachableTitlebar(window)
  } catch {
    return false
  }
}

export function recoverMainWindowBounds(window: BrowserWindow): boolean {
  if (window.isDestroyed() || window.isFullScreen() || window.isMaximized()) {
    return false
  }
  try {
    const current = window.getBounds()
    if (hasReachableTitlebar(window)) {
      return false
    }
    const workArea = getRecoveryWorkArea(current)
    const width = Math.min(current.width, workArea.width)
    const height = Math.min(current.height, workArea.height)
    window.setBounds({
      x: Math.min(Math.max(current.x, workArea.x), workArea.x + workArea.width - width),
      y: Math.min(Math.max(current.y, workArea.y), workArea.y + workArea.height - height),
      width,
      height
    })
    return true
  } catch (error) {
    console.warn('[window] Failed to recover main window bounds', error)
    return false
  }
}

export function deferMainWindowBoundsRecovery(window: BrowserWindow): void {
  if (window.isDestroyed() || pendingRecoveries.has(window)) {
    return
  }
  pendingRecoveries.add(window)
  deferAppKitSceneMutation(() => {
    pendingRecoveries.delete(window)
    recoverMainWindowBounds(window)
  })
}

export function installMainWindowReachabilityLifecycle(window: BrowserWindow): () => void {
  const recover = (): void => {
    deferMainWindowBoundsRecovery(window)
  }
  screen.on('display-added', recover)
  screen.on('display-removed', recover)
  screen.on('display-metrics-changed', recover)
  window.on('show', recover)
  window.on('restore', recover)
  window.on('unmaximize', recover)
  window.on('leave-full-screen', recover)

  return () => {
    screen.removeListener('display-added', recover)
    screen.removeListener('display-removed', recover)
    screen.removeListener('display-metrics-changed', recover)
    window.removeListener('show', recover)
    window.removeListener('restore', recover)
    window.removeListener('unmaximize', recover)
    window.removeListener('leave-full-screen', recover)
  }
}
