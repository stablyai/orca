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

describe('back-to-back vetoed quits', () => {
  // Why: the second before-quit finds the window already destroyed. If the call site read a
  // shared flag at timer-fire time instead of capturing it, the first timer would then see
  // false and never restore — leaving the bar hidden for the session with the switch still on.
  // index.ts therefore computes `getNotchWindow() !== null || notchRestorePending`.
  const wasOpenForAttempt = (hasWindow: boolean, restorePending: boolean): boolean =>
    hasWindow || restorePending

  it('still restores when the second attempt saw no window but a restore was pending', () => {
    expect(
      shouldRestoreNotchAfterQuitAttempt({
        ...base,
        wasOpenBeforeQuit: wasOpenForAttempt(false, true)
      })
    ).toBe(true)
  })

  it('does not restore when neither a window nor a pending restore existed', () => {
    expect(
      shouldRestoreNotchAfterQuitAttempt({
        ...base,
        wasOpenBeforeQuit: wasOpenForAttempt(false, false)
      })
    ).toBe(false)
  })
})
