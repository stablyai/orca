import { app, powerMonitor, screen, type BrowserWindow } from 'electron'
import { rectHasVisibleAreaOnAnyDisplay } from '../presentation/window-bounds-validation'
import {
  WORKSPACE_POPOUT_MIN_HEIGHT,
  WORKSPACE_POPOUT_MIN_WIDTH
} from '../../../shared/workspace-popout/workspace-popout-contract'

let moduleListenersAttached = false

function isWayland(): boolean {
  return (
    process.platform === 'linux' &&
    Boolean(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')
  )
}

export function repatriatePopoutsToPrimaryDisplay(windows: Iterable<BrowserWindow>): void {
  for (const win of windows) {
    if (win.isDestroyed()) {
      continue
    }
    const bounds = win.getBounds()
    if (
      !rectHasVisibleAreaOnAnyDisplay(
        bounds,
        WORKSPACE_POPOUT_MIN_WIDTH / 2,
        WORKSPACE_POPOUT_MIN_HEIGHT / 2
      )
    ) {
      try {
        const primary = screen.getPrimaryDisplay().workArea
        const width = Math.min(bounds.width, primary.width)
        const height = Math.min(bounds.height, primary.height)
        win.setBounds({
          x: primary.x + Math.max(0, Math.floor((primary.width - width) / 2)),
          y: primary.y + Math.max(0, Math.floor((primary.height - height) / 2)),
          width,
          height
        })
      } catch (err) {
        console.warn('[workspace-popout] Failed to repatriate window to primary display:', err)
      }
    }
  }
}

export function attachPopoutModuleListeners(callbacks: {
  onBeforeQuit: () => void
  onSystemResume: () => void
  onDisplayChange: () => void
}): void {
  if (moduleListenersAttached) {
    return
  }
  moduleListenersAttached = true
  app.on('before-quit', callbacks.onBeforeQuit)
  powerMonitor.on('resume', callbacks.onSystemResume)
  if (!isWayland()) {
    screen.on('display-removed', callbacks.onDisplayChange)
    screen.on('display-metrics-changed', callbacks.onDisplayChange)
  }
}

export function detachPopoutModuleListeners(callbacks: {
  onBeforeQuit: () => void
  onSystemResume: () => void
  onDisplayChange: () => void
}): void {
  if (!moduleListenersAttached) {
    return
  }
  moduleListenersAttached = false
  app.removeListener('before-quit', callbacks.onBeforeQuit)
  powerMonitor.removeListener('resume', callbacks.onSystemResume)
  if (!isWayland()) {
    screen.removeListener('display-removed', callbacks.onDisplayChange)
    screen.removeListener('display-metrics-changed', callbacks.onDisplayChange)
  }
}
