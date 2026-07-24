import type { App, BrowserWindow } from 'electron'

type FocusTimer = (callback: () => void, ms: number) => unknown

export type FocusExistingMainWindowResult = 'focused' | 'opened' | 'pending'

export type FocusExistingMainWindowOptions = {
  app: Pick<App, 'focus' | 'isReady'>
  getWindow: () => BrowserWindow | null
  openWindow: () => BrowserWindow
  platform?: NodeJS.Platform
  setTimeout?: FocusTimer
  warn?: (message: string, error?: unknown) => void
}

function safelyFocusApp(app: Pick<App, 'focus'>): void {
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
  if (window.isDestroyed()) {
    return
  }
  if (window.isMinimized()) {
    window.restore()
  }
  window.show()
  window.focus()
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

// Why: shared so the sync success path and the async retry/adopt callback can't
// drift on win32 reinforcement (moveTop/pulseAlwaysOnTop) or the 100ms focus retry.
function activateWindow(
  window: BrowserWindow,
  app: Pick<App, 'focus'>,
  platform: NodeJS.Platform,
  setTimer: FocusTimer
): void {
  safelyFocusApp(app)
  safelyRevealWindow(window)
  if (platform === 'win32') {
    try {
      window.moveTop()
    } catch {
      // Older Electron versions or destroyed windows may reject this; focus retry remains.
    }
    pulseAlwaysOnTop(window, setTimer)
  }
  retryFocus(window, app, setTimer)
}

// Why: a second-instance/activate reopen can race transient startup pressure
// (e.g. GPU/process churn right after another launch attempt exits); one
// swallowed throw would otherwise strand the app with no window until some
// later external trigger happens to retry.
const REOPEN_MAX_ATTEMPTS = 3
const REOPEN_RETRY_DELAY_MS = 300

function openWindowWithRetry(
  opts: Pick<FocusExistingMainWindowOptions, 'app' | 'getWindow' | 'openWindow' | 'warn'>,
  platform: NodeJS.Platform,
  setTimer: FocusTimer,
  attempt: number
): BrowserWindow | null {
  try {
    return opts.openWindow()
  } catch (error) {
    opts.warn?.('[window] Failed to reopen main window for second-instance launch', error)
    if (attempt >= REOPEN_MAX_ATTEMPTS) {
      return null
    }
    setTimer(() => {
      // Why: openWindow() (openMainWindow) is not idempotent — it constructs and
      // registers a fresh BrowserWindow on every call. Between attempts another
      // path (or a first attempt that threw after creating its window) may have
      // produced a live window, so adopt it instead of opening a duplicate that
      // would orphan the one already on screen.
      const existing = opts.getWindow()
      const window =
        existing && !existing.isDestroyed()
          ? existing
          : openWindowWithRetry(opts, platform, setTimer, attempt + 1)
      if (window) {
        activateWindow(window, opts.app, platform, setTimer)
      }
    }, REOPEN_RETRY_DELAY_MS)
    return null
  }
}

export function focusExistingMainWindow(
  opts: FocusExistingMainWindowOptions
): FocusExistingMainWindowResult {
  const platform = opts.platform ?? process.platform
  const setTimer = opts.setTimeout ?? setTimeout
  let window = opts.getWindow()
  let openedWindow = false

  if (!window || window.isDestroyed()) {
    if (!opts.app.isReady()) {
      return 'pending'
    }
    window = openWindowWithRetry(opts, platform, setTimer, 1)
    if (!window) {
      return 'pending'
    }
    openedWindow = true
  }

  activateWindow(window, opts.app, platform, setTimer)
  return openedWindow ? 'opened' : 'focused'
}
