import { app, ipcMain, type BrowserWindow } from 'electron'

export type MainWindowAccessibilitySupport = {
  dispose: () => void
}

// Why: renderer panes mount after the initial 'accessibility-support-changed' would have fired, so
// a synchronous getter seeds the first value the same way window:isMaximized seeds WindowControls.
const IS_ENABLED_CHANNEL = 'window:isAccessibilitySupportEnabled'
const CHANGED_CHANNEL = 'window:accessibility-support-changed'

// Why re-read instead of trusting the event, and why for this long: Chromium turns accessibility on
// asynchronously and never announces the moment it lands. Measured on macOS 26.5.1 with a client
// attaching to a running window -- the getter read false at 202 ms, 'accessibility-support-changed'
// arrived at 358 ms carrying **false**, and the getter finally went true at 2.4 s with nothing
// further emitted. So the payload cannot be trusted and one re-read at event time is still too
// early: the getter is the only authority, and it is read again on a widening schedule until the
// answer changes or the schedule runs out.
//
// The horizon is deliberately far past the 2.4 s that was measured, because that was an idle
// machine and there is no second event to fall back on -- if the flag flips after the last read,
// the panes stay unreadable for the life of the window. Each read is one boolean, and the schedule
// stops the moment the answer changes, so a slow settle costs a handful of reads and a quiet event
// costs eight.
const SETTLE_DELAYS_MS = [0, 250, 1_000, 2_500, 5_000, 10_000, 20_000, 40_000] as const

/**
 * Publishes Chromium's accessibility-support flag to the renderer.
 *
 * Why: xterm only builds its accessibility DOM when screenReaderMode is on, and Orca never turns it
 * on — so every pane's output is invisible to VoiceOver, Narrator and every other assistive client.
 * Electron reports whether one is attached, which is the same signal VS Code drives its terminal's
 * screenReaderMode from.
 *
 * Cross-platform: app.isAccessibilitySupportEnabled() is macOS/Windows only and returns false on
 * Linux, where this is inert rather than wrong.
 */
export function installMainWindowAccessibilitySupport(args: {
  mainWindow: BrowserWindow
}): MainWindowAccessibilitySupport {
  const { mainWindow } = args

  // Undefined until the renderer has been told something. Read lazily rather than at install:
  // nothing needs the answer until a pane asks for it or the flag moves, and installing a window
  // should not depend on an Electron call it does not use yet.
  let published: boolean | undefined
  let settleTimers: ReturnType<typeof setTimeout>[] = []

  const clearSettleTimers = (): void => {
    for (const timer of settleTimers) {
      clearTimeout(timer)
    }
    settleTimers = []
  }

  const publishIfChanged = (): void => {
    // Why both, and why it matters here: webContents dies just before the 'closed' event, and the
    // timers are only cleared by dispose() at 'closed' -- so a settle read can land in that gap and
    // send into a destroyed webContents. Same guard the rest of the tree uses before sending from a
    // timer (createMainWindow's onSystemResume, terminal-tab-close-request-relay).
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed?.() === true) {
      clearSettleTimers()
      return
    }
    const enabled = app.isAccessibilitySupportEnabled()
    if (published === undefined) {
      // Nothing has asked yet, so there is nobody to tell and nothing to compare against: every
      // pane host reads the getter when it registers. Record the baseline and keep reading. Ending
      // the schedule here instead would publish the read this module exists to distrust -- the one
      // taken before Chromium has finished -- and then stop looking, which is the whole failure.
      published = enabled
      return
    }
    if (enabled === published) {
      return
    }
    published = enabled
    // The change is what the schedule was waiting for. A flip back emits its own event and starts
    // a fresh schedule, so nothing is lost by stopping here.
    clearSettleTimers()
    mainWindow.webContents.send(CHANGED_CHANNEL, enabled)
  }

  const onIsEnabled = (): boolean => {
    const enabled = app.isAccessibilitySupportEnabled()
    // Seeded once and then left alone. `published` means "what the renderer has been told", and
    // answering one asker is not telling the renderer: overwriting it here would let a second read
    // taken after a transition settled match the next settle read, skip the send, and leave whoever
    // read the old value holding it. Seeding from the first read is still right -- before anyone
    // has asked there is nothing to preserve, and it is what makes a later change a change.
    if (published === undefined) {
      published = enabled
    }
    return enabled
  }

  const onChanged = (): void => {
    clearSettleTimers()
    settleTimers = SETTLE_DELAYS_MS.map((delay) => {
      const timer = setTimeout(publishIfChanged, delay)
      // Why unref: a pending re-read must not be the reason the process stays alive on quit.
      timer.unref?.()
      return timer
    })
  }

  // Why remove first: openMainWindow is not idempotent -- it builds and registers a fresh window on
  // every call, and openWindowWithRetry catches a throw from it and calls it again up to three
  // times. This handler is installed early in that construction, so a throw anywhere after it
  // leaves the channel registered with no window to dispose it; ipcMain.handle then throws on the
  // retry and turns a transient startup failure into a permanent one, having spent every attempt.
  // removeHandler is a no-op when nothing is registered, so this costs nothing on the normal path.
  ipcMain.removeHandler(IS_ENABLED_CHANNEL)
  ipcMain.handle(IS_ENABLED_CHANNEL, onIsEnabled)
  app.on('accessibility-support-changed', onChanged)

  const dispose = (): void => {
    clearSettleTimers()
    ipcMain.removeHandler(IS_ENABLED_CHANNEL)
    app.removeListener('accessibility-support-changed', onChanged)
  }
  return { dispose }
}
