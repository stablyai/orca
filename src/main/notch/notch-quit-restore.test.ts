import { describe, expect, it } from 'vitest'
import { shouldRestoreNotchAfterQuitAttempt } from './notch-quit-restore'

const base = {
  quitCommitted: false,
  hasAppWindow: true,
  settingEnabled: true,
  wasOpenBeforeQuit: true
}

describe('shouldRestoreNotchAfterQuitAttempt', () => {
  it('restores when a quit was started and then vetoed', () => {
    // Why: `before-quit` tears the bar down so window-all-closed can fire. A dirty editor tab
    // or a settings close-guard can cancel the quit afterwards, and on those paths will-quit
    // never fires and isQuitting is never cleared — so nothing else brings the bar back.
    expect(shouldRestoreNotchAfterQuitAttempt(base)).toBe(true)
  })

  it('does not restore once the quit reached will-quit', () => {
    expect(shouldRestoreNotchAfterQuitAttempt({ ...base, quitCommitted: true })).toBe(false)
  })

  it('does not restore when no app window survived', () => {
    // Why: covers the gap before will-quit fires — recreating an always-on-top window mid-quit
    // would re-suppress window-all-closed and strand the app.
    expect(shouldRestoreNotchAfterQuitAttempt({ ...base, hasAppWindow: false })).toBe(false)
  })

  it('does not restore when the user turned the setting off', () => {
    expect(shouldRestoreNotchAfterQuitAttempt({ ...base, settingEnabled: false })).toBe(false)
  })

  it('does not restore a bar that was already closed before the quit', () => {
    expect(shouldRestoreNotchAfterQuitAttempt({ ...base, wasOpenBeforeQuit: false })).toBe(false)
  })

  it('needs every condition at once', () => {
    expect(
      shouldRestoreNotchAfterQuitAttempt({
        quitCommitted: true,
        hasAppWindow: false,
        settingEnabled: false,
        wasOpenBeforeQuit: false
      })
    ).toBe(false)
  })
})
