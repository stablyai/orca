import { app, autoUpdater, type BrowserWindow, type Event } from 'electron'
import type { Store } from '../persistence'
import { uiZoomFactorFromLevel } from '../../shared/ui-zoom-level'
import {
  isBackgroundLaunch,
  isWindowlessLaunch,
  showWindowWithoutStealingFocus
} from './foreground-activation-policy'
import { MIN_HEIGHT, MIN_WIDTH, syncTrafficLightPosition } from './main-window-visual-lifecycle'

export type MainWindowStateLifecycle = {
  clearInitialRevealFallbackTimer: () => void
  dispose: () => void
  freezeBoundsOnQuit: (event?: Event) => void
  isWindowClosing: () => boolean
  resumeBoundsPersistence: () => void
}

export function installMainWindowStateLifecycle(args: {
  mainWindow: BrowserWindow
  revealOnDidFinishLoad: boolean
  savedMaximized: boolean
  savedFullscreen: boolean
  store: Store | null
}): MainWindowStateLifecycle {
  const { mainWindow, revealOnDidFinishLoad, savedMaximized, savedFullscreen, store } = args
  mainWindow.webContents.on('dom-ready', () => {
    const level = store?.getUI().uiZoomLevel ?? 0
    mainWindow.webContents.setZoomLevel(level)
    // Native traffic lights do not scale with CSS zoom; align them with the titlebar on startup.
    if (process.platform === 'darwin') {
      syncTrafficLightPosition(mainWindow, uiZoomFactorFromLevel(level))
    }
  })

  // Electron 41/macOS reemits ready-to-show for webview creation; run initial maximize only once (#591).
  let handledInitialReadyToShow = false
  let initialRevealFallbackTimer: ReturnType<typeof setTimeout> | null =
    process.platform === 'win32' || process.platform === 'linux'
      ? setTimeout(() => {
          // GPU failures can suppress ready-to-show forever on Windows/Linux; reveal the only window via fallback (#8421).
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

    // Keep headless E2E off screen; Playwright uses CDP.
    if (isWindowlessLaunch()) {
      return
    }
    if (savedMaximized) {
      mainWindow.maximize()
    }
    showWindowWithoutStealingFocus(mainWindow)
    if (savedFullscreen && !isBackgroundLaunch()) {
      mainWindow.setFullScreen(true)
    }
  }
  mainWindow.on('ready-to-show', revealInitialWindow)
  if (revealOnDidFinishLoad === true) {
    mainWindow.webContents.on('did-finish-load', revealInitialWindow)
  }

  // Debounce bounds persistence during resize drags.
  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  // Teardown emits near-minimum bounds; freeze writes once closing to preserve remembered size.
  let windowClosing = false
  const persistBounds = (): void => {
    if (
      windowClosing ||
      mainWindow.isDestroyed() ||
      mainWindow.isMinimized() ||
      mainWindow.isFullScreen()
    ) {
      return
    }
    const isMaximized = mainWindow.isMaximized()
    const bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    if (bounds.width <= MIN_WIDTH || bounds.height <= MIN_HEIGHT) {
      console.warn('[window] Skipping persist of near-minimum windowBounds:', bounds)
      store?.updateUI({ windowMaximized: isMaximized })
      return
    }
    store?.updateUI({ windowMaximized: isMaximized, windowBounds: bounds })
  }
  const saveBounds = (): void => {
    if (boundsTimer) {
      clearTimeout(boundsTimer)
    }
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      persistBounds()
    }, 500)
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)

  const freezeBoundsOnQuit = (event?: Event): void => {
    if (event?.defaultPrevented) {
      return
    }
    if (boundsTimer) {
      clearTimeout(boundsTimer)
      boundsTimer = null
      persistBounds()
    }
    windowClosing = true
  }
  app.on('before-quit', freezeBoundsOnQuit)
  // Native updates close windows before app's before-quit, after removing window close listeners.
  const nativeUpdater =
    process.platform === 'darwin' || process.platform === 'win32' ? autoUpdater : null
  nativeUpdater?.on('before-quit-for-update', freezeBoundsOnQuit)

  mainWindow.on('maximize', () => {
    if (windowClosing) {
      return
    }
    persistBounds()
    mainWindow.webContents.send('window:maximize-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    if (windowClosing) {
      return
    }
    mainWindow.webContents.send('window:maximize-changed', false)
    persistBounds()
  })

  mainWindow.on('enter-full-screen', () => {
    if (!windowClosing) {
      store?.updateUI({ windowFullscreen: true })
    }
    mainWindow.webContents.send('window:fullscreen-changed', true)
  })

  mainWindow.on('leave-full-screen', () => {
    if (!windowClosing) {
      store?.updateUI({ windowFullscreen: false })
    }
    mainWindow.webContents.send('window:fullscreen-changed', false)
  })

  const resumeBoundsPersistence = (): void => {
    windowClosing = false
  }
  return {
    clearInitialRevealFallbackTimer,
    dispose: () => {
      app.removeListener('before-quit', freezeBoundsOnQuit)
      nativeUpdater?.removeListener('before-quit-for-update', freezeBoundsOnQuit)
    },
    freezeBoundsOnQuit,
    isWindowClosing: () => windowClosing,
    resumeBoundsPersistence
  }
}
