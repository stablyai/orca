import { describe, expect, it, vi } from 'vitest'
import { createHangWatchdogDetectionLoop } from './hang-watchdog-detection-loop'

const TIMEOUT_MS = 45_000
const CHECK_INTERVAL_MS = 5_000

function loopWithClock(startAt = 0) {
  let now = startAt
  const onHangDetected = vi.fn()
  const onHangResolved = vi.fn()
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: TIMEOUT_MS,
    checkIntervalMs: CHECK_INTERVAL_MS,
    now: () => now,
    onHangDetected,
    onHangResolved
  })
  return { loop, onHangDetected, onHangResolved, advance: (ms: number) => (now += ms) }
}

describe('createHangWatchdogDetectionLoop', () => {
  it('does not fire while heartbeats keep arriving', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    for (let i = 0; i < 100; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.recordHeartbeat()
      loop.tick()
    }
    expect(onHangDetected).not.toHaveBeenCalled()
  })

  it('fires once when heartbeats stop for longer than the timeout', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 12; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledTimes(1)
    advance(CHECK_INTERVAL_MS)
    loop.tick()
    expect(onHangDetected).toHaveBeenCalledTimes(1)
  })

  it('reports the measured stall duration, not the timeout', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 12; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledWith(50_000)
  })

  it('does not fire at exactly the timeout boundary', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 9; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).not.toHaveBeenCalled()
  })

  it('treats a large tick gap as system sleep and restarts the wait', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    loop.recordHeartbeat()
    // Model system suspension: the watchdog itself missed multiple timer ticks.
    advance(TIMEOUT_MS * 4)
    loop.tick()
    expect(onHangDetected).not.toHaveBeenCalled()
    // After wake, require a fresh timeout of silence rather than counting suspended time.
    for (let i = 0; i < 9; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).not.toHaveBeenCalled()
    for (let i = 0; i < 3; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledTimes(1)
  })

  it('reports resolution when heartbeats resume after a detected hang', () => {
    const { loop, onHangDetected, onHangResolved, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 12; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledTimes(1)
    advance(CHECK_INTERVAL_MS)
    loop.recordHeartbeat()
    expect(onHangResolved).toHaveBeenCalledTimes(1)
    expect(onHangResolved).toHaveBeenCalledWith(13 * CHECK_INTERVAL_MS)
  })

  it('does not report resolution when no hang was ever detected', () => {
    const { loop, onHangResolved, advance } = loopWithClock()
    for (let i = 0; i < 5; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.recordHeartbeat()
      loop.tick()
    }
    expect(onHangResolved).not.toHaveBeenCalled()
  })

  it('can detect a second hang after the first one resolved', () => {
    const { loop, onHangDetected, onHangResolved, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 12; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    advance(CHECK_INTERVAL_MS)
    loop.recordHeartbeat()
    expect(onHangResolved).toHaveBeenCalledTimes(1)
    // Keep the tick clock advancing during a hang so recovery cannot look like system suspension.
    for (let i = 0; i < 12; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledTimes(2)
  })
})
