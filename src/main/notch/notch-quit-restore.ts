// Decides whether a quit attempt that tore the notch down was actually a quit.
//
// Why this exists: the bar must be destroyed on `before-quit`, because Electron only emits
// `window-all-closed` once the last window is gone and Orca uses that event to complete a
// Cmd+Q its renderer deferred. But a quit can still be vetoed — a dirty editor tab or a
// settings close-guard cancels it — and on those paths `will-quit` never fires and Orca's
// `isQuitting` latch is never cleared, so nothing re-creates the bar for the rest of the
// session while the settings switch still reports it as on.
//
// Enumerating veto sites was the obvious fix and is the wrong one: they differ per dialog,
// they live in the renderer, and the list will drift. Instead: tear down, then notice we are
// still alive and put it back.

export type NotchQuitRestoreDecision = {
  /** Set once `will-quit` fires — the quit reached its committed phase. */
  quitCommitted: boolean
  /** A vetoed quit definitionally still has the window whose guard vetoed it. */
  hasAppWindow: boolean
  /** The persisted preference, which a quit never changes. */
  settingEnabled: boolean
  /** False when the bar was already closed before the quit, so there is nothing to restore. */
  wasOpenBeforeQuit: boolean
}

export function shouldRestoreNotchAfterQuitAttempt({
  quitCommitted,
  hasAppWindow,
  settingEnabled,
  wasOpenBeforeQuit
}: NotchQuitRestoreDecision): boolean {
  if (!wasOpenBeforeQuit || !settingEnabled) {
    return false
  }
  // Both guards are needed: `will-quit` is the authoritative commit signal, and the surviving
  // app window covers the gap before it fires — recreating an always-on-top window mid-quit
  // would re-suppress `window-all-closed` and strand the app.
  return !quitCommitted && hasAppWindow
}

/** Long enough for a committed quit to have reached `will-quit`, short enough to feel instant. */
export const NOTCH_QUIT_ABORT_GRACE_MS = 3000
