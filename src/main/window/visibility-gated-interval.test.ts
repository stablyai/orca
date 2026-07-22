import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startVisibilityGatedInterval } from './visibility-gated-interval'

const INTERVAL_MS = 2_000

describe('startVisibilityGatedInterval', () => {
  let visible: boolean
  let becameVisibleListeners: Set<() => void>

  beforeEach(() => {
    vi.useFakeTimers()
    visible = true
    becameVisibleListeners = new Set()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makeGate(): Parameters<typeof startVisibilityGatedInterval>[2] {
    return {
      isWindowVisible: () => visible,
      onWindowBecameVisible: (listener) => {
        becameVisibleListeners.add(listener)
        return () => becameVisibleListeners.delete(listener)
      }
    }
  }

  function notifyBecameVisible(): void {
    for (const listener of becameVisibleListeners) {
      listener()
    }
  }

  it('ticks at the normal cadence while visible', () => {
    const tick = vi.fn()
    const gated = startVisibilityGatedInterval(tick, INTERVAL_MS, makeGate())
    vi.advanceTimersByTime(INTERVAL_MS * 3)
    expect(tick).toHaveBeenCalledTimes(3)
    gated.dispose()
  })

  it('stops ticking entirely while the window is hidden', () => {
    const tick = vi.fn()
    const gated = startVisibilityGatedInterval(tick, INTERVAL_MS, makeGate())
    visible = false
    // First hidden fire tears the timer down without running the tick; from
    // then on there are zero wakeups no matter how long we stay hidden.
    vi.advanceTimersByTime(INTERVAL_MS * 30)
    expect(tick).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    gated.dispose()
  })

  it('runs exactly one immediate catch-up tick on became-visible and resumes the cadence', () => {
    const tick = vi.fn()
    const gated = startVisibilityGatedInterval(tick, INTERVAL_MS, makeGate())
    visible = false
    vi.advanceTimersByTime(INTERVAL_MS * 5)
    expect(tick).not.toHaveBeenCalled()

    visible = true
    notifyBecameVisible()
    expect(tick).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(INTERVAL_MS * 2)
    expect(tick).toHaveBeenCalledTimes(3)
    gated.dispose()
  })

  it('ignores became-visible while the timer is still running (no double scheduling)', () => {
    const tick = vi.fn()
    const gated = startVisibilityGatedInterval(tick, INTERVAL_MS, makeGate())
    notifyBecameVisible()
    expect(tick).not.toHaveBeenCalled()
    vi.advanceTimersByTime(INTERVAL_MS)
    expect(tick).toHaveBeenCalledTimes(1)
    gated.dispose()
  })

  it('removes the became-visible listener and timer on dispose', () => {
    const tick = vi.fn()
    const gated = startVisibilityGatedInterval(tick, INTERVAL_MS, makeGate())
    expect(becameVisibleListeners.size).toBe(1)
    gated.dispose()
    expect(becameVisibleListeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    notifyBecameVisible()
    vi.advanceTimersByTime(INTERVAL_MS * 3)
    expect(tick).not.toHaveBeenCalled()
  })

  it('does not resume after dispose even if hidden-then-visible races teardown', () => {
    const tick = vi.fn()
    const gated = startVisibilityGatedInterval(tick, INTERVAL_MS, makeGate())
    visible = false
    vi.advanceTimersByTime(INTERVAL_MS)
    const listeners = [...becameVisibleListeners]
    gated.dispose()
    visible = true
    // Simulate a stale listener reference firing after dispose.
    for (const listener of listeners) {
      listener()
    }
    vi.advanceTimersByTime(INTERVAL_MS * 3)
    expect(tick).not.toHaveBeenCalled()
  })

  it('runs unconditionally when no gate is provided', () => {
    const tick = vi.fn()
    const gated = startVisibilityGatedInterval(tick, INTERVAL_MS)
    vi.advanceTimersByTime(INTERVAL_MS * 2)
    expect(tick).toHaveBeenCalledTimes(2)
    gated.dispose()
    vi.advanceTimersByTime(INTERVAL_MS * 2)
    expect(tick).toHaveBeenCalledTimes(2)
  })
})
