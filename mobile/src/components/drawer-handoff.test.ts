import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDrawerHandoff } from './drawer-handoff'

describe('createDrawerHandoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the follow-up only after the hide animation completes', () => {
    const handoff = createDrawerHandoff(150)
    const openNext = vi.fn()

    handoff.run(openNext)
    // Why: opening the follow-up before the current drawer finishes closing is
    // exactly what strands two iOS modals and freezes the app (issue #8555).
    expect(openNext).not.toHaveBeenCalled()

    vi.advanceTimersByTime(149)
    expect(openNext).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(openNext).toHaveBeenCalledTimes(1)
  })

  it('supersedes a queued follow-up so only the latest one opens', () => {
    const handoff = createDrawerHandoff(150)
    const first = vi.fn()
    const second = vi.fn()

    handoff.run(first)
    handoff.run(second)
    vi.advanceTimersByTime(150)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('dispose cancels a pending follow-up (e.g. on unmount)', () => {
    const handoff = createDrawerHandoff(150)
    const openNext = vi.fn()

    handoff.run(openNext)
    handoff.dispose()
    vi.advanceTimersByTime(150)

    expect(openNext).not.toHaveBeenCalled()
  })

  it('defaults to the shared bottom-drawer hide duration', () => {
    const handoff = createDrawerHandoff()
    const openNext = vi.fn()

    handoff.run(openNext)
    vi.advanceTimersByTime(150)

    expect(openNext).toHaveBeenCalledTimes(1)
  })
})
