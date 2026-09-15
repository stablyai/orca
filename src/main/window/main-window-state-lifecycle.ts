import { app, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { isWindowlessLaunch, showWindowWithoutStealingFocus } from './foreground-activation-policy'
import { MIN_HEIGHT, MIN_WIDTH, syncTrafficLightPosition } from './main-window-visual-lifecycle'

/** Last-resort reveal when no first frame ever arrives. */
const INITIAL_REVEAL_FALLBACK_MS = 10_000

export type MainWindowStateLifecycle = {
  clearInitialRevealFallbackTimer: () => void
  /** Reveal the startup window now, for callers that learn no first frame is coming. */
  revealInitialWindow: () => void
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
  // Why every platform: ready-to-show needs a first frame, so a renderer or GPU process that dies
  // before painting never fires it and leaves the only app window hidden forever (#8421). macOS was
  // excluded until the darwin SIGTRAP-at-startup cluster (fa0a6033/8468e3ec) showed the same shape:
  // GPU, network service and renderer all trap ~200-750ms after window creation, before first paint.
  let initialRevealFallbackTimer: ReturnType<typeof setTimeout> | null = null
  const armInitialRevealFallbackTimer = (): void => {
    initialRevealFallbackTimer = setTimeout(() => {
      initialRevealFallbackTimer = null
      revealInitialWindow()
    }, INITIAL_REVEAL_FALLBACK_MS)
    initialRevealFallbackTimer.unref?.()
  }
  armInitialRevealFallbackTimer()

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
    // Why separate from the show below: restoring maximized geometry is optional, and it runs renderer
    // notifications that can throw on a dead frame. A failed restore must never cost the reveal.
    if (savedMaximized) {
      try {
        mainWindow.maximize()
      } catch (error) {
        console.warn('[window] Startup maximize failed; revealing unmaximized', error)
      }
    }
    // Why re-arm rather than just unlatch: this also runs from render-process-gone, and the fallback
    // timer was already spent above. Without re-arming, a throw here leaves no reveal signal at all in
    // exactly the no-first-frame case this exists for.
    try {
      showWindowWithoutStealingFocus(mainWindow)
    } catch (error) {
      handledInitialReadyToShow = false
      armInitialRevealFallbackTimer()
      console.warn(
        '[window] Startup window reveal failed; retrying on the next reveal signal',
        error
      )
    }
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

  // Why: maximize() is reachable from the pre-paint reveal path, where the renderer is already gone;
  // an unguarded send throws out of maximize() and would starve the reveal that called it.
  const sendMaximizeChanged = (maximized: boolean): void => {
    const contents = mainWindow.webContents
    if (contents.isDestroyed() || contents.isCrashed?.() === true) {
      return
    }
    try {
      contents.send('window:maximize-changed', maximized)
    } catch (error) {
      console.warn('[window] Skipped maximize notification for an unavailable frame', error)
    }
  }

  mainWindow.on('maximize', () => {
    if (windowClosing) {
      return
    }
    store?.updateUI({ windowMaximized: true })
    sendMaximizeChanged(true)
  })
  mainWindow.on('unmaximize', () => {
    if (windowClosing) {
      return
    }
    sendMaximizeChanged(false)
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
    revealInitialWindow,
    dispose: () => app.removeListener('before-quit', freezeBoundsOnQuit),
    freezeBoundsOnQuit,
    isWindowClosing: () => windowClosing,
    resumeBoundsPersistence
  }
}
