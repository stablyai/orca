// The startup ceiling measures awake time: a machine that sleeps while an agent starts must not
// expire the start the moment it wakes.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAwakeClock, type AwakeClock } from '../../../power/awake-clock'
import { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'
import { STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS } from './structured-agent-session-startup-attempt-contract'

let monotonic = 0
let clock: AwakeClock

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2026-11-09T09:08:32-08:00'))
  monotonic = 0
  clock = createAwakeClock({ wallNow: () => Date.now(), monotonicNow: () => monotonic })
})

afterEach(() => {
  vi.useRealTimers()
})

function attempts(expire: () => void) {
  return new StructuredAgentSessionStartupAttempts({ expire, now: () => clock.now() })
}

/** The machine sleeps: wall time passes; timers due by then fire on wake, before the resume event. */
async function sleepFor(ms: number): Promise<void> {
  clock.suspend()
  await vi.advanceTimersByTimeAsync(ms)
  clock.resume()
}

async function awakeFor(ms: number): Promise<void> {
  monotonic += ms
  await vi.advanceTimersByTimeAsync(ms)
}

it('does not expire a start whose machine slept past the ceiling', async () => {
  const expire = vi.fn()
  const startup = attempts(expire)
  const { registeredAt } = startup.begin('session', 'attempt')

  await awakeFor(2_000)
  await sleepFor(665_000)
  await awakeFor(1_000)

  expect(expire).not.toHaveBeenCalled()
  expect(startup.pastCeiling(registeredAt)).toBe(false)
  expect(startup.isOpen('session')).toBe(true)
  startup.dispose()
})

it('still expires once the start has been awake for the whole ceiling', async () => {
  const expire = vi.fn()
  const startup = attempts(expire)
  const { registeredAt } = startup.begin('session', 'attempt')

  await awakeFor(2_000)
  await sleepFor(665_000)
  await awakeFor(STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS - 3_000)
  expect(expire).not.toHaveBeenCalled()

  await awakeFor(1_000)
  expect(startup.pastCeiling(registeredAt)).toBe(true)
  await vi.waitFor(() => expect(expire).toHaveBeenCalledOnce())
  startup.dispose()
})

it('measures the ceiling on the wall clock when nothing reports a sleep', async () => {
  const expire = vi.fn()
  const startup = attempts(expire)
  startup.begin('session', 'attempt')
  await awakeFor(STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS)
  await vi.waitFor(() => expect(expire).toHaveBeenCalledOnce())
  startup.dispose()
})
