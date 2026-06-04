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

function safelyRevealWindow(window: BrowserWindow): void {
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
    try {
      window = opts.openWindow()
      openedWindow = true
    } catch (error) {
      opts.warn?.('[window] Failed to reopen main window for second-instance launch', error)
      return 'pending'
    }
  }

  safelyFocusApp(opts.app)
  safelyRevealWindow(window)
  if (platform === 'win32') {
    try {
      window.moveTop()
    } catch {
      // Older Electron versions or destroyed windows may reject this; focus retry remains.
    }
    pulseAlwaysOnTop(window, setTimer)
  }
  retryFocus(window, opts.app, setTimer)
  return openedWindow ? 'opened' : 'focused'
}
