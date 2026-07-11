import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_IDLE_EXIT_GRACE_MS, DaemonIdleExit } from './daemon-idle-exit'

const GRACE_MS = 1_000

function createIdleExit(opts: { graceMs?: number } = {}): {
  idleExit: DaemonIdleExit
  onExpired: ReturnType<typeof vi.fn>
  setIdle: (value: boolean) => void
} {
  let idle = true
  const onExpired = vi.fn()
  const idleExit = new DaemonIdleExit({
    isIdle: () => idle,
    onExpired,
    ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {})
  })
  return {
    idleExit,
    onExpired,
    setIdle: (value: boolean) => {
      idle = value
    }
  }
}

describe('DaemonIdleExit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires onExpired only after the full grace period while idle', () => {
    const { idleExit, onExpired } = createIdleExit({ graceMs: GRACE_MS })

    idleExit.evaluate()
    expect(idleExit.isArmed()).toBe(true)

    vi.advanceTimersByTime(GRACE_MS - 1)
    expect(onExpired).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onExpired).toHaveBeenCalledTimes(1)
    expect(idleExit.isArmed()).toBe(false)
  })

  it('does not arm while non-idle', () => {
    const { idleExit, onExpired, setIdle } = createIdleExit({ graceMs: GRACE_MS })
    setIdle(false)

    idleExit.evaluate()

    expect(idleExit.isArmed()).toBe(false)
    vi.advanceTimersByTime(GRACE_MS * 10)
    expect(onExpired).not.toHaveBeenCalled()
  })

  it('cancels a pending countdown when evaluated non-idle, then re-arms once idle again', () => {
    const { idleExit, onExpired, setIdle } = createIdleExit({ graceMs: GRACE_MS })
    idleExit.evaluate()
    expect(idleExit.isArmed()).toBe(true)

    setIdle(false)
    idleExit.evaluate()
    expect(idleExit.isArmed()).toBe(false)
    vi.advanceTimersByTime(GRACE_MS * 2)
    expect(onExpired).not.toHaveBeenCalled()

    setIdle(true)
    idleExit.evaluate()
    vi.advanceTimersByTime(GRACE_MS)
    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('keeps the original deadline on redundant idle evaluations', () => {
    const { idleExit, onExpired } = createIdleExit({ graceMs: GRACE_MS })
    idleExit.evaluate()

    vi.advanceTimersByTime(GRACE_MS / 2)
    idleExit.evaluate()

    // A deadline-extending implementation would need another full grace here.
    vi.advanceTimersByTime(GRACE_MS / 2)
    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('refuses to expire when idleness was lost without an evaluate call', () => {
    const { idleExit, onExpired, setIdle } = createIdleExit({ graceMs: GRACE_MS })
    idleExit.evaluate()

    // Simulate a missed cancel path: state became non-idle but nobody called
    // evaluate(). The fire-time re-check must keep the daemon alive.
    setIdle(false)
    vi.advanceTimersByTime(GRACE_MS)
    expect(onExpired).not.toHaveBeenCalled()

    // Recovery stays event-driven: the next idle evaluate re-arms.
    setIdle(true)
    idleExit.evaluate()
    vi.advanceTimersByTime(GRACE_MS)
    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('dispose cancels the countdown and blocks future arming', () => {
    const { idleExit, onExpired } = createIdleExit({ graceMs: GRACE_MS })
    idleExit.evaluate()

    idleExit.dispose()
    expect(idleExit.isArmed()).toBe(false)
    vi.advanceTimersByTime(GRACE_MS * 2)

    idleExit.evaluate()
    expect(idleExit.isArmed()).toBe(false)
    vi.advanceTimersByTime(GRACE_MS * 2)
    expect(onExpired).not.toHaveBeenCalled()
  })

  it('defaults to the 10-minute grace period', () => {
    const { idleExit, onExpired } = createIdleExit()
    idleExit.evaluate()

    vi.advanceTimersByTime(DAEMON_IDLE_EXIT_GRACE_MS - 1)
    expect(onExpired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('unrefs the countdown so it cannot keep the daemon process alive', () => {
    vi.useRealTimers()
    const { idleExit } = createIdleExit({ graceMs: 60_000 })
    try {
      idleExit.evaluate()
      const timer = (idleExit as unknown as { timer: NodeJS.Timeout | null }).timer
      expect(timer?.hasRef()).toBe(false)
    } finally {
      idleExit.dispose()
    }
  })
})
