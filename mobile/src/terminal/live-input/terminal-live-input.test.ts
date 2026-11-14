import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearTerminalLiveInputFocusTimer,
  scheduleTerminalLiveInputFocus,
  type TerminalLiveInputFocusTimerRef
} from './terminal-live-input'

function createTimerRef(): TerminalLiveInputFocusTimerRef {
  return { current: null }
}

describe('terminal live input', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces pending deferred focus work', () => {
    vi.useFakeTimers()
    const timerRef = createTimerRef()
    const staleFocus = vi.fn()
    const nextFocus = vi.fn()

    scheduleTerminalLiveInputFocus(timerRef, staleFocus)
    scheduleTerminalLiveInputFocus(timerRef, nextFocus)
    vi.runOnlyPendingTimers()

    expect(staleFocus).not.toHaveBeenCalled()
    expect(nextFocus).toHaveBeenCalledTimes(1)
    expect(timerRef.current).toBeNull()
  })

  it('clears pending deferred focus work', () => {
    vi.useFakeTimers()
    const timerRef = createTimerRef()
    const focus = vi.fn()

    scheduleTerminalLiveInputFocus(timerRef, focus)
    clearTerminalLiveInputFocusTimer(timerRef)
    vi.runOnlyPendingTimers()

    expect(focus).not.toHaveBeenCalled()
    expect(timerRef.current).toBeNull()
  })
})
