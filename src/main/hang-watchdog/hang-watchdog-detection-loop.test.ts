import { describe, expect, it, vi } from 'vitest'
import { createHangWatchdogDetectionLoop } from './hang-watchdog-detection-loop'

const TIMEOUT_MS = 45_000
const CHECK_INTERVAL_MS = 5_000

function loopWithClock(startAt = 0, stallMs?: number) {
  let now = startAt
  const onHangDetected = vi.fn()
  const onHangResolved = vi.fn()
  const onStallDetected = vi.fn()
  const onStallMissed = vi.fn()
  const loop = createHangWatchdogDetectionLoop({
    timeoutMs: TIMEOUT_MS,
    checkIntervalMs: CHECK_INTERVAL_MS,
    stallMs,
    now: () => now,
    onHangDetected,
    onHangResolved,
    onStallDetected,
    onStallMissed
  })
  return {
    loop,
    onHangDetected,
    onHangResolved,
    onStallDetected,
    onStallMissed,
    advance: (ms: number) => (now += ms)
  }
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

  it('reports a stall that recovers before the hang timeout, then resolves it', () => {
    const { loop, onStallDetected, onHangDetected, onHangResolved, advance } = loopWithClock(
      0,
      8_000
    )
    loop.recordHeartbeat()
    advance(5_000)
    loop.tick()
    advance(5_000)
    loop.tick()
    expect(onStallDetected).toHaveBeenCalledExactlyOnceWith(10_000)
    advance(3_000)
    loop.recordHeartbeat()
    expect(onHangResolved).toHaveBeenCalledExactlyOnceWith(13_000)
    expect(onHangDetected).not.toHaveBeenCalled()
  })

  it('escalates the same episode from stall to hang', () => {
    const { loop, onStallDetected, onHangDetected, onHangResolved, advance } = loopWithClock(
      0,
      8_000
    )
    loop.recordHeartbeat()
    for (let i = 0; i < 10; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onStallDetected).toHaveBeenCalledTimes(1)
    expect(onHangDetected).toHaveBeenCalledExactlyOnceWith(50_000)
    loop.recordHeartbeat()
    expect(onHangResolved).toHaveBeenCalledTimes(1)
  })

  it('records a stall no tick saw once heartbeats resume', () => {
    const { loop, onStallDetected, onStallMissed, advance } = loopWithClock(0, 8_000)
    loop.recordHeartbeat()
    loop.tick()
    advance(4_000)
    loop.tick()
    advance(5_000)
    loop.recordHeartbeat()
    expect(onStallDetected).not.toHaveBeenCalled()
    expect(onStallMissed).toHaveBeenCalledExactlyOnceWith(9_000, 0)
  })

  it('does not call a heartbeat after system sleep a missed stall', () => {
    const { loop, onStallMissed, advance } = loopWithClock(0, 8_000)
    loop.recordHeartbeat()
    loop.tick()
    // The watchdog's own ticks stopped too, so the silence belongs to the machine.
    advance(20_000)
    loop.recordHeartbeat()
    expect(onStallMissed).not.toHaveBeenCalled()
  })

  it('ends a detected stall at a sleep gap instead of growing it into a hang', () => {
    let now = 0
    const onHangDetected = vi.fn()
    const onHangResolved = vi.fn()
    const onStallEndedBySleep = vi.fn()
    const loop = createHangWatchdogDetectionLoop({
      timeoutMs: TIMEOUT_MS,
      checkIntervalMs: CHECK_INTERVAL_MS,
      stallMs: 8_000,
      now: () => now,
      onHangDetected,
      onHangResolved,
      onStallDetected: vi.fn(),
      onStallEndedBySleep
    })
    loop.recordHeartbeat()
    now += 5_000
    loop.tick()
    now += 5_000
    loop.tick()
    now += 3_600_000
    loop.tick()
    expect(onStallEndedBySleep).toHaveBeenCalledTimes(1)
    now += 5_000
    loop.tick()
    expect(onHangDetected).not.toHaveBeenCalled()
    loop.recordHeartbeat()
    expect(onHangResolved).not.toHaveBeenCalled()
  })

  it('ends a stall woken before the overdue tick without reporting the sleep as stall time', () => {
    let now = 0
    const order: string[] = []
    const onHangResolved = vi.fn()
    const onStallEndedBySleep = vi.fn()
    const loop = createHangWatchdogDetectionLoop({
      timeoutMs: TIMEOUT_MS,
      checkIntervalMs: CHECK_INTERVAL_MS,
      stallMs: 8_000,
      now: () => now,
      onHangDetected: vi.fn(),
      onHangResolved,
      onStallDetected: () => true,
      onStallEndedBySleep: () => {
        order.push('ended')
        onStallEndedBySleep()
      },
      onWatchdogGap: () => order.push('gap')
    })
    loop.recordHeartbeat()
    now += 5_000
    loop.tick()
    now += 5_000
    loop.tick()
    now += 3_600_000
    loop.recordHeartbeat()
    expect(onStallEndedBySleep).toHaveBeenCalledTimes(1)
    expect(onHangResolved).not.toHaveBeenCalled()
    expect(order).toEqual(['gap', 'ended'])
    now += CHECK_INTERVAL_MS
    loop.tick()
    expect(order).toEqual(['gap', 'ended'])
  })

  it('restarts the stall clock when a detected silence was a suspend, so a stall after wake is still seen', () => {
    let now = 0
    const stalls: number[] = []
    let suspended = true
    const loop = createHangWatchdogDetectionLoop({
      timeoutMs: TIMEOUT_MS,
      checkIntervalMs: CHECK_INTERVAL_MS,
      stallMs: 8_000,
      now: () => now,
      onHangDetected: vi.fn(),
      onHangResolved: vi.fn(),
      onStallDetected: (ms) => {
        stalls.push(ms)
        const accepted = !suspended
        suspended = false
        return accepted
      }
    })
    loop.recordHeartbeat()
    loop.tick()
    now += 10_000
    loop.tick()
    for (let i = 0; i < 2; i++) {
      now += 5_000
      loop.tick()
    }
    expect(stalls).toEqual([10_000, 10_000])
  })

  it('keeps a wake heartbeat that arrived before the overdue tick, so a stall right after wake is timed from it', () => {
    const { loop, onStallMissed, advance } = loopWithClock(0, 8_000)
    loop.recordHeartbeat()
    loop.tick()
    advance(60_000)
    loop.recordHeartbeat()
    advance(1_000)
    loop.tick()
    advance(7_500)
    loop.recordHeartbeat()
    expect(onStallMissed).toHaveBeenCalledExactlyOnceWith(8_500, 60_000)
  })

  it('does not count a sleep as main silence when the overdue tick wakes first after a pre-sleep heartbeat', () => {
    const { loop, onHangDetected, onStallMissed, advance } = loopWithClock(0, 8_000)
    loop.recordHeartbeat()
    loop.tick()
    advance(1_000)
    loop.recordHeartbeat()
    advance(120_000)
    loop.tick()
    advance(5_000)
    loop.tick()
    expect(onHangDetected).not.toHaveBeenCalled()
    advance(2_000)
    loop.recordHeartbeat()
    expect(onStallMissed).not.toHaveBeenCalled()
  })

  it('keeps the heartbeat that resolved a hang on wake, so the next stall is timed from it', () => {
    const { loop, onHangResolved, onStallMissed, advance } = loopWithClock(0, 8_000)
    loop.recordHeartbeat()
    for (let i = 0; i < 10; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    advance(70_000)
    loop.recordHeartbeat()
    expect(onHangResolved).toHaveBeenCalledTimes(1)
    advance(1_000)
    loop.tick()
    advance(5_000)
    loop.tick()
    advance(2_500)
    loop.recordHeartbeat()
    expect(onStallMissed).toHaveBeenCalledExactlyOnceWith(8_500, 120_000)
  })

  it('drops a wake heartbeat when the machine slept again before the overdue tick', () => {
    const { loop, onHangDetected, advance } = loopWithClock(0, 8_000)
    loop.recordHeartbeat()
    loop.tick()
    advance(60_000)
    loop.recordHeartbeat()
    advance(60_000)
    loop.tick()
    advance(5_000)
    loop.tick()
    expect(onHangDetected).not.toHaveBeenCalled()
  })
})
