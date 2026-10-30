import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMobileSessionTabsNotifyCoalescer } from './mobile-session-tabs-notify-coalescer'

describe('createMobileSessionTabsNotifyCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a rapid burst of title/status flips into one trailing emit (repro)', () => {
    // Title spinners generate bursts; publish only the latest state after the trailing window.
    const emit = vi.fn()
    const coalescer = createMobileSessionTabsNotifyCoalescer(emit)

    const FLIPS = 20
    for (let i = 0; i < FLIPS; i++) {
      coalescer.schedule('worktree-1')
      vi.advanceTimersByTime(10)
    }
    expect(emit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(50)

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('worktree-1')
  })

  it('force-flushes under sustained churn so the emit is never starved', () => {
    const emit = vi.fn()
    const coalescer = createMobileSessionTabsNotifyCoalescer(emit)

    // Sustained churn must still publish within the 250ms cap.
    for (let i = 0; i < 100; i++) {
      coalescer.schedule('worktree-1')
      vi.advanceTimersByTime(30)
    }

    expect(emit).toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('worktree-1')
  })

  it('keeps per-worktree windows independent', () => {
    const emit = vi.fn()
    const coalescer = createMobileSessionTabsNotifyCoalescer(emit)

    coalescer.schedule('worktree-1')
    coalescer.schedule('worktree-2')
    vi.advanceTimersByTime(50)

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenCalledWith('worktree-1')
    expect(emit).toHaveBeenCalledWith('worktree-2')
  })

  it('cancel() drops a pending notify so a structural emit can supersede it', () => {
    const emit = vi.fn()
    const coalescer = createMobileSessionTabsNotifyCoalescer(emit)

    coalescer.schedule('worktree-1')
    // Structural changes emit immediately elsewhere and cancel trailing notifications.
    coalescer.cancel('worktree-1')
    vi.advanceTimersByTime(50)

    expect(emit).not.toHaveBeenCalled()
  })

  it('flush() emits the pending notify immediately', () => {
    const emit = vi.fn()
    const coalescer = createMobileSessionTabsNotifyCoalescer(emit)

    coalescer.schedule('worktree-1')
    coalescer.flush('worktree-1')

    expect(emit).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(50)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('flush() is a no-op when nothing is pending', () => {
    const emit = vi.fn()
    const coalescer = createMobileSessionTabsNotifyCoalescer(emit)

    coalescer.flush('worktree-1')

    expect(emit).not.toHaveBeenCalled()
  })

  it('flushAll() drains every pending worktree (subscription close)', () => {
    const emit = vi.fn()
    const coalescer = createMobileSessionTabsNotifyCoalescer(emit)

    coalescer.schedule('worktree-1')
    coalescer.schedule('worktree-2')
    coalescer.flushAll()

    expect(emit).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(50)
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('dispose() drops pending timers without emitting', () => {
    const emit = vi.fn()
    const coalescer = createMobileSessionTabsNotifyCoalescer(emit)

    coalescer.schedule('worktree-1')
    coalescer.dispose()
    vi.advanceTimersByTime(50)

    expect(emit).not.toHaveBeenCalled()
  })
})
