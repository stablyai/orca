import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleInputFocus } from './schedule-input-focus'

describe.each(['idle', 'frame'])('input focus after an %s callback', (kind) => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestIdleCallback',
      kind === 'idle' ? (callback: () => void) => setTimeout(callback, 1) : undefined
    )
    vi.stubGlobal('cancelIdleCallback', clearTimeout)
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 1))
    vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the keyboard delay after the opening callback', () => {
    const focus = vi.fn()
    scheduleInputFocus(focus, 120)
    vi.advanceTimersByTime(120)
    expect(focus).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it.each([0, 1])('does not reopen the keyboard when the field closes after %i ms', (elapsed) => {
    const focus = vi.fn()
    const cancel = scheduleInputFocus(focus, 120)
    vi.advanceTimersByTime(elapsed)
    cancel()
    vi.runAllTimers()
    expect(focus).not.toHaveBeenCalled()
  })
})
