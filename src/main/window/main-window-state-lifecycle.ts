import { app, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { isWindowlessLaunch, showWindowWithoutStealingFocus } from './foreground-activation-policy'
import { MIN_HEIGHT, MIN_WIDTH, syncTrafficLightPosition } from './main-window-visual-lifecycle'

export type MainWindowStateLifecycle = {
  clearInitialRevealFallbackTimer: () => void
  dispose: () => void
  freezeBoundsOnQuit: () => void
  isWindowClosing: () => boolean
  resumeBoundsPersistence: () => void
}

export function installMainWindowStateLifecycle(args: {
  mainWindow: BrowserWindow
  revealOnDidFinishLoad: boolean
  savedMaximized: boolean
  store: Store | null
}): MainWindowStateLifecycle {
  const { mainWindow, revealOnDidFinishLoad, savedMaximized, store } = args
  mainWindow.webContents.on('dom-ready', () => {
    const level = store?.getUI().uiZoomLevel ?? 0
    mainWindow.webContents.setZoomLevel(level)
    // Why: native traffic lights don't scale with CSS zoom; reposition on startup to stay aligned with the zoomed titlebar.
    if (process.platform === 'darwin') {
      syncTrafficLightPosition(mainWindow, 1.2 ** level)
    }
  })

  // Why: macOS+Electron 41 re-emits ready-to-show on webview-guest creation; a one-shot guard stops re-running maximize() after resize (#591).
  let handledInitialReadyToShow = false
  let initialRevealFallbackTimer: ReturnType<typeof setTimeout> | null =
    process.platform === 'win32' || process.platform === 'linux'
      ? setTimeout(() => {
          // Why: GPU/driver failures on Windows/Linux can prevent ready-to-show forever, hiding the only app window (#8421).
          initialRevealFallbackTimer = null
          revealInitialWindow()
        }, 10_000)
      : null
  initialRevealFallbackTimer?.unref?.()

  const clearInitialRevealFallbackTimer = (): void => {
    if (initialRevealFallbackTimer) {
      clearTimeout(initialRevealFallbackTimer)
      initialRevealFallbackTimer = null
    }
  }

  const revealInitialWindow = (): void => {
    if (mainWindow.isDestroyed()) {
      clearInitialRevealFallbackTimer()
      return
    }
    if (handledInitialReadyToShow) {
      return
    }
    handledInitialReadyToShow = true
    clearInitialRevealFallbackTimer()

    // Why: headless E2E keeps the window off screen entirely (Playwright drives via CDP).
    if (isWindowlessLaunch()) {
      return
    }
    if (savedMaximized) {
      mainWindow.maximize()
    }
    showWindowWithoutStealingFocus(mainWindow)
  }
  mainWindow.on('ready-to-show', revealInitialWindow)
  if (revealOnDidFinishLoad === true) {
    mainWindow.webContents.on('did-finish-load', revealInitialWindow)
  }

  // Why: persist window bounds to restore last position/size; debounce to avoid hammering persistence during resize drags.
  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  // Why: teardown still emits resize/move/unmaximize at near-min bounds; freeze persistence once closing so they can't clobber the saved size.
  let windowClosing = false
  const saveBounds = (): void => {
    if (boundsTimer) {
      clearTimeout(boundsTimer)
    }
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      if (windowClosing || mainWindow.isDestroyed() || mainWindow.isFullScreen()) {
        return
      }
      // Why: persist windowMaximized and windowBounds atomically; the near-min guard must not leave them a mismatched pair.
      const isMaximized = mainWindow.isMaximized()
      if (isMaximized) {
        store?.updateUI({ windowMaximized: true })
        return
      }
      const bounds = mainWindow.getBounds()
      // Why: never persist shrink-to-min bounds (teardown race past the freeze, PR #1269); fall back to defaultBounds next launch.
      if (bounds.width <= MIN_WIDTH || bounds.height <= MIN_HEIGHT) {
        console.warn('[window] Skipping persist of near-minimum windowBounds:', bounds)
        store?.updateUI({ windowMaximized: false })
        return
      }
      store?.updateUI({ windowMaximized: false, windowBounds: bounds })
    }, 500)
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)

  // Why: the auto-updater calls removeAllListeners('close') before quitting, so latch on app 'before-quit' too to freeze bounds during teardown.
  const freezeBoundsOnQuit = (): void => {
    windowClosing = true
    if (boundsTimer) {
      clearTimeout(boundsTimer)
      boundsTimer = null
    }
  }
  app.on('before-quit', freezeBoundsOnQuit)

  mainWindow.on('maximize', () => {
    if (windowClosing) {
      return
    }
    store?.updateUI({ windowMaximized: true })
    mainWindow.webContents.send('window:maximize-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    if (windowClosing) {
      return
    }
    mainWindow.webContents.send('window:maximize-changed', false)
    const bounds = mainWindow.getBounds()
    // Why: mirror the saveBounds guard — unmaximize during teardown can land at min size; don't persist that as remembered size.
    if (bounds.width <= MIN_WIDTH || bounds.height <= MIN_HEIGHT) {
      console.warn('[window] Skipping unmaximize-time persist of near-min bounds:', bounds)
      store?.updateUI({ windowMaximized: false })
      return
    }
    store?.updateUI({ windowMaximized: false, windowBounds: bounds })
  })

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('window:fullscreen-changed', true)
  })

  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('window:fullscreen-changed', false)
  })

  const resumeBoundsPersistence = (): void => {
    windowClosing = false
  }
  return {
    clearInitialRevealFallbackTimer,
    dispose: () => app.removeListener('before-quit', freezeBoundsOnQuit),
    freezeBoundsOnQuit,
    isWindowClosing: () => windowClosing,
    resumeBoundsPersistence
  }
}
