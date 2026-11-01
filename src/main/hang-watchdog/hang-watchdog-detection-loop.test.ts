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
