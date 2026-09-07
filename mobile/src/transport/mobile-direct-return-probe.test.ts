import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DirectReturnProbe } from './mobile-direct-return-probe'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import { FakeSession, host } from './mobile-endpoint-supervisor-test-fakes'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

// A LAN that never answers: every dial sits open until the probe's own 12s budget.
function fixture() {
  const opened: FakeSession[] = []
  const probe = new DirectReturnProbe(
    {
      now: Date.now,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
      openDirect: () => {
        const candidate = new FakeSession('connecting')
        opened.push(candidate)
        return candidate
      }
    },
    {
      hysteresis: new MobileEndpointHysteresis(Date.now(), {
        directSuccessesRequired: 1,
        directObservationMs: 60_000,
        failureCooldownMs: 0,
        minimumDwellMs: 0
      }),
      host: () => host,
      canSchedule: () => true,
      canAttempt: () => true,
      beginOperation: () => {},
      migrate: async () => {},
      onDirectMigrated: async () => {},
      afterProbe: () => {}
    }
  )
  return { opened, probe }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('never opens a second dial while one is still in flight', async () => {
  const { opened, probe } = fixture()
  probe.schedule(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(opened).toHaveLength(1)

  // A relay drop and a foreground return both ask for an immediate probe while the
  // first dial is still awaiting authentication.
  probe.schedule(0)
  probe.schedule(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(opened).toHaveLength(1)

  // Why this is the assertion that matters: a second probe would have overwritten
  // activeProbe, so stop() would abort only the newest dial and leave this socket
  // open for the rest of its 12s budget.
  probe.stop()
  await vi.advanceTimersByTimeAsync(0)
  expect(opened[0]!.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('honors an urgent reprobe asked for mid-dial instead of dropping it on the 15s floor', async () => {
  const { opened, probe } = fixture()
  probe.schedule(0)
  await vi.advanceTimersByTimeAsync(0)
  probe.schedule(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(opened).toHaveLength(1)

  // The deferred ask survives the dial and runs at once when it settles, so holding
  // the slot does not cost the caller the 15s it was trying to skip.
  await vi.advanceTimersByTimeAsync(12_000)
  await vi.advanceTimersByTimeAsync(1)
  expect(opened).toHaveLength(2)
  probe.stop()
})

it('falls back to the ordinary interval when nothing asked for a sooner probe', async () => {
  const { opened, probe } = fixture()
  probe.schedule(0)
  await vi.advanceTimersByTimeAsync(12_000)
  expect(opened).toHaveLength(1)

  await vi.advanceTimersByTimeAsync(14_999)
  expect(opened).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(opened).toHaveLength(2)
  probe.stop()
})
