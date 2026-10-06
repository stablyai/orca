import { setImmediate as waitForPoll } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  publishSystemResume,
  publishSystemSuspend,
  type SystemPowerLifecycleListener
} from '../../system-power-lifecycle'
import {
  createProfileStateWriterDeadline,
  PROFILE_STATE_WRITER_MAX_GRACES,
  PROFILE_STATE_WRITER_OVERDUE_GRACE_MS
} from './profile-state-writer-deadline'

const TIMEOUT_MS = 30_000

afterEach(() => {
  vi.useRealTimers()
  publishSystemResume()
})

function harness() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const clock = { now: 1_000 }
  let power!: SystemPowerLifecycleListener
  const unsubscribe = vi.fn()
  const onTimeout = vi.fn()
  const onGrace = vi.fn()
  const deadline = createProfileStateWriterDeadline(TIMEOUT_MS, onTimeout, {
    now: () => clock.now,
    onGrace,
    subscribePowerLifecycle: (listener) => {
      power = listener
      // The real lifecycle replays its current state during subscription.
      listener.onResume()
      return unsubscribe
    }
  })
  // Advance fake timers and the monotonic clock together, as a running loop would.
  const run = (ms: number) => {
    clock.now += ms
    vi.advanceTimersByTime(ms)
  }
  // A stalled loop: monotonic time passes but no callback runs.
  const stall = (ms: number) => {
    clock.now += ms
  }
  return { deadline, onTimeout, onGrace, unsubscribe, run, stall, power: () => power }
}

describe('profile state writer deadline', () => {
  it('times out a request after allowing queued replies to drain', async () => {
    const { onTimeout, onGrace, unsubscribe, run } = harness()
    run(TIMEOUT_MS - 1)
    expect(onTimeout).not.toHaveBeenCalled()
    run(1)
    expect(onGrace).not.toHaveBeenCalled()
    expect(onTimeout).not.toHaveBeenCalled()
    await waitForPoll()
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ overdueMs: 0, graces: 0, powerState: 'awake' })
    )
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('grants a fresh window when the callback arrives after a stalled loop', async () => {
    const { onTimeout, onGrace, run, stall } = harness()
    stall(3 * 60 * 60_000)
    run(TIMEOUT_MS)
    expect(onTimeout).not.toHaveBeenCalled()
    expect(onGrace).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ overdueMs: 3 * 60 * 60_000, graces: 1 })
    )
    run(TIMEOUT_MS - 1)
    expect(onTimeout).not.toHaveBeenCalled()
    run(1)
    await waitForPoll()
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ overdueMs: 0, graces: 1 })
    )
  })

  it('does not grant a full extra window for ordinary scheduling jitter', async () => {
    const { onTimeout, onGrace, run, stall } = harness()
    stall(PROFILE_STATE_WRITER_OVERDUE_GRACE_MS - 1)
    run(TIMEOUT_MS)
    expect(onGrace).not.toHaveBeenCalled()
    await waitForPoll()
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('bounds grace across repeated stalls so a hung worker still times out', async () => {
    const { onTimeout, onGrace, run, stall } = harness()
    for (let episode = 0; episode < PROFILE_STATE_WRITER_MAX_GRACES; episode += 1) {
      stall(60 * 60_000)
      run(TIMEOUT_MS)
      expect(onTimeout).not.toHaveBeenCalled()
    }
    stall(60 * 60_000)
    run(TIMEOUT_MS)
    expect(onGrace).toHaveBeenCalledTimes(PROFILE_STATE_WRITER_MAX_GRACES)
    await waitForPoll()
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ graces: PROFILE_STATE_WRITER_MAX_GRACES })
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('spends one grace to give a fresh window on resume', async () => {
    const { onTimeout, onGrace, run, power } = harness()
    run(TIMEOUT_MS - 1_000)
    power().onSuspend()
    power().onResume()
    run(TIMEOUT_MS - 1)
    expect(onTimeout).not.toHaveBeenCalled()
    run(1)
    await waitForPoll()
    expect(onGrace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ graces: 1 }))
    expect(onTimeout).toHaveBeenCalledOnce()
  })

  it('stays bounded when a suspend is never followed by resume', async () => {
    const { onTimeout, onGrace, run } = harness()
    // Dark wake: the loop runs on time, but the system still reports suspended.
    publishSystemSuspend()
    for (let window = 0; window < PROFILE_STATE_WRITER_MAX_GRACES; window += 1) {
      run(TIMEOUT_MS)
    }
    expect(onGrace).toHaveBeenCalledTimes(PROFILE_STATE_WRITER_MAX_GRACES)
    expect(onTimeout).not.toHaveBeenCalled()
    run(TIMEOUT_MS)
    await waitForPoll()
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ powerState: 'suspended' })
    )
  })

  it.each([false, true])(
    'bounds repeated resumes with paired suspend events: %s',
    async (paired) => {
      const { deadline, onTimeout, run, power } = harness()
      try {
        for (let cycle = 0; cycle <= PROFILE_STATE_WRITER_MAX_GRACES; cycle += 1) {
          run(TIMEOUT_MS - 1)
          if (paired) {
            power().onSuspend()
          }
          power().onResume()
        }
        run(1)
        await waitForPoll()
        expect(onTimeout).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ graces: PROFILE_STATE_WRITER_MAX_GRACES })
        )
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        deadline.clear()
      }
    }
  )

  it('shares the grace limit between overdue timers and resume events', async () => {
    const { deadline, onTimeout, onGrace, run, stall, power } = harness()
    try {
      for (let cycle = 1; cycle < PROFILE_STATE_WRITER_MAX_GRACES; cycle += 1) {
        stall(PROFILE_STATE_WRITER_OVERDUE_GRACE_MS)
        run(TIMEOUT_MS)
      }
      power().onResume()
      run(TIMEOUT_MS)
      // An exhausted resume must not cancel the final queued timeout check.
      power().onResume()
      await waitForPoll()
      expect(onGrace).toHaveBeenCalledTimes(PROFILE_STATE_WRITER_MAX_GRACES)
      expect(onTimeout).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      deadline.clear()
    }
  })

  it('cancels an expired timeout check when a reply clears the deadline', async () => {
    const { deadline, onTimeout, unsubscribe, run } = harness()
    run(TIMEOUT_MS)
    deadline.clear()
    await waitForPoll()
    expect(onTimeout).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an expired timeout check when resume re-arms the deadline', async () => {
    const { onTimeout, run, power } = harness()
    run(TIMEOUT_MS)
    power().onResume()
    await waitForPoll()
    expect(onTimeout).not.toHaveBeenCalled()
    run(TIMEOUT_MS)
    await waitForPoll()
    expect(onTimeout).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases its timer and subscription when cleared, and ignores later power events', () => {
    const { deadline, onTimeout, unsubscribe, run, power } = harness()
    deadline.clear()
    deadline.clear()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    power().onResume()
    run(10 * TIMEOUT_MS)
    expect(vi.getTimerCount()).toBe(0)
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
