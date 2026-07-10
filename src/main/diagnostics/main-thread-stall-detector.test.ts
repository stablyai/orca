import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { endMock, startSpanMock } = vi.hoisted(() => {
  const end = vi.fn()
  return { endMock: end, startSpanMock: vi.fn(() => ({ end })) }
})

vi.mock('../observability/tracer', () => ({
  startSpan: startSpanMock
}))

import {
  startMainThreadStallDetector,
  stopMainThreadStallDetector
} from './main-thread-stall-detector'

// The detector reads `performance.now()` once per tick; driving that clock
// independently of the fake timer is what lets us simulate a late tick.
let nowSpy: ReturnType<typeof vi.spyOn>

function tickAt(ms: number): void {
  nowSpy.mockReturnValue(ms)
  vi.advanceTimersByTime(1_000)
}

beforeEach(() => {
  vi.useFakeTimers()
  nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0)
  startSpanMock.mockClear()
  endMock.mockClear()
})

afterEach(() => {
  stopMainThreadStallDetector()
  vi.useRealTimers()
  nowSpy.mockRestore()
})

describe('startMainThreadStallDetector', () => {
  it('stays silent when ticks land on time', () => {
    startMainThreadStallDetector()
    tickAt(1_000)
    tickAt(2_000)
    tickAt(3_000)
    expect(startSpanMock).not.toHaveBeenCalled()
  })

  it('stays silent for sub-threshold jank', () => {
    startMainThreadStallDetector()
    // 999ms late — jank, not a freeze.
    tickAt(1_999)
    expect(startSpanMock).not.toHaveBeenCalled()
  })

  it('emits one main-thread.stall span with the block time when a tick fires late', () => {
    startMainThreadStallDetector()
    // Tick due at 1000ms actually ran at 4500ms ⇒ the thread was blocked 3500ms.
    tickAt(4_500)
    expect(startSpanMock).toHaveBeenCalledTimes(1)
    expect(startSpanMock).toHaveBeenCalledWith('main-thread.stall', {
      attributes: { gapMs: 3_500, tickMs: 1_000 }
    })
    expect(endMock).toHaveBeenCalledTimes(1)
  })

  it('measures each stall from the previous tick, not from start', () => {
    startMainThreadStallDetector()
    tickAt(4_500)
    // Next tick due at 5500ms, ran at 8000ms ⇒ 2500ms of block, not 7000ms.
    tickAt(8_000)
    expect(startSpanMock).toHaveBeenLastCalledWith('main-thread.stall', {
      attributes: { gapMs: 2_500, tickMs: 1_000 }
    })
  })

  it('is idempotent — a second start does not double-arm the timer', () => {
    startMainThreadStallDetector()
    startMainThreadStallDetector()
    tickAt(4_500)
    expect(startSpanMock).toHaveBeenCalledTimes(1)
  })

  it('stops emitting once stopped', () => {
    startMainThreadStallDetector()
    stopMainThreadStallDetector()
    tickAt(4_500)
    expect(startSpanMock).not.toHaveBeenCalled()
  })
})
