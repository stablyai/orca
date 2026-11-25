import type { App, BrowserWindow } from 'electron'
import {
  isBackgroundLaunch,
  isWindowlessLaunch,
  showWindowWithoutStealingFocus
} from './foreground-activation-policy'

type FocusTimer = (callback: () => void, ms: number) => unknown

export type FocusExistingMainWindowResult = 'focused' | 'opened' | 'pending'

export type FocusExistingMainWindowOptions = {
  app: Pick<App, 'focus' | 'isReady'>
  getWindow: () => BrowserWindow | null
  // Structural: the web project typechecks this file and can't reach main-window-contracts.
  openWindow: (options?: { revealInBackground?: boolean }) => BrowserWindow | Promise<BrowserWindow>
  /** `orca open` asked: show the window if needed, never take the foreground. */
  background?: boolean
  /** False while some other path must own the first window; the reopen is dropped, not queued. */
  canOpenWindow?: () => boolean
  platform?: NodeJS.Platform
  setTimeout?: FocusTimer
  warn?: (message: string, error?: unknown) => void
}

function safelyFocusApp(app: Pick<App, 'focus'>): void {
  // Real second-instance reopen may claim foreground; automated launches must never do so.
  if (isBackgroundLaunch()) {
    return
  }
  try {
    app.focus({ steal: true })
  } catch {
    try {
      app.focus()
    } catch {
      // Best-effort; BrowserWindow focus below may still work.
    }
  }
}

export function safelyRevealWindow(window: BrowserWindow): void {
  if (window.isDestroyed() || isWindowlessLaunch()) {
    return
  }
  if (window.isMinimized()) {
    window.restore()
  }
  showWindowWithoutStealingFocus(window)
  if (!isBackgroundLaunch()) {
    window.focus()
  }
}

function pulseAlwaysOnTop(window: BrowserWindow, setTimer: FocusTimer): void {
  if (window.isDestroyed() || window.isAlwaysOnTop()) {
    return
  }

  try {
    window.setAlwaysOnTop(true)
  } catch {
    return
  }

  setTimer(() => {
    if (!window.isDestroyed()) {
      window.setAlwaysOnTop(false)
    }
  }, 250)
}

function retryFocus(window: BrowserWindow, app: Pick<App, 'focus'>, setTimer: FocusTimer): void {
  setTimer(() => {
    if (window.isDestroyed()) {
      return
    }
    safelyFocusApp(app)
    safelyRevealWindow(window)
  }, 100)
}

// Share Windows foreground reinforcement and delayed focus retry across synchronous and retry/adoption paths.
function activateWindow(
  window: BrowserWindow,
  app: Pick<App, 'focus'>,
  platform: NodeJS.Platform,
  setTimer: FocusTimer,
  background: boolean
): void {
  if (background) {
    // A minimized window stays minimized: restoring it would pull the user's attention.
    if (
      !window.isDestroyed() &&
      !window.isVisible() &&
      !window.isMinimized() &&
      !isWindowlessLaunch()
    ) {
      window.showInactive()
    }
    return
  }
  safelyFocusApp(app)
  safelyRevealWindow(window)
  // Windows reinforcement raises windows over other work; suppress it during background launches.
  if (platform === 'win32' && !isBackgroundLaunch()) {
    try {
      window.moveTop()
    } catch {
      // Older Electron versions or destroyed windows may reject this; focus retry remains.
    }
    pulseAlwaysOnTop(window, setTimer)
    retryFocus(window, app, setTimer)
  }
}

// Transient startup/process pressure can reject window creation; bounded retries prevent a permanently windowless app.
const REOPEN_MAX_ATTEMPTS = 3
const REOPEN_RETRY_DELAY_MS = 300

function openWindowWithRetry(
  opts: Pick<
    FocusExistingMainWindowOptions,
    'app' | 'getWindow' | 'openWindow' | 'canOpenWindow' | 'warn'
  >,
  platform: NodeJS.Platform,
  setTimer: FocusTimer,
  attempt: number,
  background: boolean
): BrowserWindow | null | Promise<BrowserWindow | null> {
  const failed = (error: unknown): null => {
    opts.warn?.('[window] Failed to reopen main window for second-instance launch', error)
    if (attempt >= REOPEN_MAX_ATTEMPTS) {
      return null
    }
    setTimer(() => {
      const existing = opts.getWindow()
      if (existing && !existing.isDestroyed()) {
        activateWindow(existing, opts.app, platform, setTimer, background)
        return
      }
      if (opts.canOpenWindow?.() === false) {
        return
      }
      const window = openWindowWithRetry(opts, platform, setTimer, attempt + 1, background)
      if (window instanceof Promise) {
        void window.then((ready) => {
          if (ready && !background) {
            activateWindow(ready, opts.app, platform, setTimer, false)
          }
        })
      } else if (window && !background) {
        activateWindow(window, opts.app, platform, setTimer, false)
      }
    }, REOPEN_RETRY_DELAY_MS)
    return null
  }
  try {
    const window = opts.openWindow(background ? { revealInBackground: true } : undefined)
    return window instanceof Promise ? window.catch(failed) : window
  } catch (error) {
    return failed(error)
  }
}

export function focusExistingMainWindow(
  opts: FocusExistingMainWindowOptions
): FocusExistingMainWindowResult {
  const platform = opts.platform ?? process.platform
  const setTimer = opts.setTimeout ?? setTimeout
  const background = opts.background === true
  let window = opts.getWindow()
  let openedWindow = false

  if (!window || window.isDestroyed()) {
    if (!opts.app.isReady() || opts.canOpenWindow?.() === false) {
      return 'pending'
    }
    const opening = openWindowWithRetry(opts, platform, setTimer, 1, background)
    if (opening instanceof Promise) {
      void opening.then((ready) => {
        if (ready && !background) {
          activateWindow(ready, opts.app, platform, setTimer, false)
        }
      })
      return 'pending'
    }
    window = opening
    if (!window) {
      return 'pending'
    }
    openedWindow = true
  }

  // A window opened in the background reveals itself inactive on first paint.
  if (!(openedWindow && background)) {
    activateWindow(window, opts.app, platform, setTimer, background)
  }
  return openedWindow ? 'opened' : 'focused'
}
