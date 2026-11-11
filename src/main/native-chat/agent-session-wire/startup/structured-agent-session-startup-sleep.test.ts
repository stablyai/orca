// The startup ceiling measures awake time: a machine that sleeps while an agent starts must not
// expire the start the moment it wakes. These run on the production default clock.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS } from './structured-agent-session-startup-attempt-contract'
import type * as SystemPowerLifecycle from '../../../power/system-power-lifecycle'
import type * as StartupAttempt from './structured-agent-session-startup-attempt'

let power: typeof SystemPowerLifecycle
let Attempts: typeof StartupAttempt.StructuredAgentSessionStartupAttempts

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout']
  })
  vi.setSystemTime(new Date('2026-11-09T09:08:32-08:00'))
  // A fresh process-wide awake clock and power state for each test.
  vi.resetModules()
  power = await import('../../../power/system-power-lifecycle')
  ;({ StructuredAgentSessionStartupAttempts: Attempts } =
    await import('./structured-agent-session-startup-attempt'))
})

afterEach(() => {
  vi.useRealTimers()
})

/** The machine sleeps: wall time passes while no timers run; then the system reports the wake. */
function sleepFor(ms: number): void {
  power.publishSystemSuspend()
  vi.setSystemTime(Date.now() + ms)
  power.publishSystemResume()
}

async function awakeFor(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

it('does not expire a start whose machine slept past the ceiling', async () => {
  const expire = vi.fn()
  const startup = new Attempts({ expire })
  const { registeredAt } = startup.begin('session', 'attempt')

  await awakeFor(2_000)
  sleepFor(665_000)
  await awakeFor(1_000)

  expect(expire).not.toHaveBeenCalled()
  expect(startup.pastCeiling(registeredAt)).toBe(false)
  expect(startup.isOpen('session')).toBe(true)
  startup.dispose()
})

it('still expires once the start has been awake for the whole ceiling', async () => {
  const expire = vi.fn()
  const startup = new Attempts({ expire })
  const { registeredAt } = startup.begin('session', 'attempt')

  await awakeFor(2_000)
  sleepFor(665_000)
  await awakeFor(STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS - 3_000)
  expect(expire).not.toHaveBeenCalled()

  await awakeFor(1_000)
  expect(startup.pastCeiling(registeredAt)).toBe(true)
  await vi.waitFor(() => expect(expire).toHaveBeenCalledOnce())
  startup.dispose()
})

it('measures the full ceiling when nothing reports a sleep', async () => {
  const expire = vi.fn()
  const startup = new Attempts({ expire })
  startup.begin('session', 'attempt')
  await awakeFor(STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS - 1_000)
  expect(expire).not.toHaveBeenCalled()
  await awakeFor(1_000)
  await vi.waitFor(() => expect(expire).toHaveBeenCalledOnce())
  startup.dispose()
})
