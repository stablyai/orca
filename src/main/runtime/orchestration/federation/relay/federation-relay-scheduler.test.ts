import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FederationRelayScheduler,
  type FederationRelayTickOutcome
} from './federation-relay-scheduler'

function scripted(outcomes: FederationRelayTickOutcome[]) {
  const calls: number[] = []
  const tick = vi.fn(async () => {
    calls.push(Date.now())
    return outcomes.shift() ?? 'failed'
  })
  return { tick, calls }
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('FederationRelayScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('doubles the wait after each failure up to one minute', async () => {
    const { tick, calls } = scripted([])
    const relays = new FederationRelayScheduler(tick)
    relays.arm('dispatch-1', 'env-1')
    await advance(10 * 60_000)

    const gaps = calls.slice(1).map((at, index) => at - calls[index])
    expect(gaps.slice(0, 7)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
    relays.clear()
  })

  it('returns to one-second syncs after a success', async () => {
    const { tick, calls } = scripted(['failed', 'failed', 'synced', 'synced'])
    const relays = new FederationRelayScheduler(tick)
    relays.arm('dispatch-1', 'env-1')
    await advance(2_000 + 4_000 + 1_000)

    expect(calls).toEqual([0, 2_000, 6_000, 7_000])
    relays.clear()
  })

  it('syncs at once when armed again but keeps its failure count', async () => {
    const { tick, calls } = scripted(['failed', 'failed', 'failed'])
    const relays = new FederationRelayScheduler(tick)
    relays.arm('dispatch-1', 'env-1')
    await advance(2_000)
    expect(calls).toEqual([0, 2_000])

    relays.arm('dispatch-1', 'env-1')
    await advance(0)
    expect(calls).toEqual([0, 2_000, 2_000])
    // Third consecutive failure waits 8 s, not the 2 s a reset would give.
    await advance(7_999)
    expect(calls).toHaveLength(3)
    await advance(1)
    expect(calls).toHaveLength(4)
    relays.clear()
  })

  it('runs once more right after an in-flight sync when nudged during it', async () => {
    let finish: (outcome: FederationRelayTickOutcome) => void = () => {}
    const tick = vi.fn(
      () => new Promise<FederationRelayTickOutcome>((resolve) => (finish = resolve))
    )
    const relays = new FederationRelayScheduler(tick)
    relays.arm('dispatch-1', 'env-1')
    relays.arm('dispatch-1', 'env-1')
    expect(tick).toHaveBeenCalledTimes(1)

    finish('failed')
    await advance(0)
    expect(tick).toHaveBeenCalledTimes(2)
    relays.clear()
  })

  it('does not reschedule a sync that finishes after the relay was cleared', async () => {
    let finish: (outcome: FederationRelayTickOutcome) => void = () => {}
    const tick = vi.fn(
      () => new Promise<FederationRelayTickOutcome>((resolve) => (finish = resolve))
    )
    const relays = new FederationRelayScheduler(tick)
    relays.arm('dispatch-1', 'env-1')
    relays.clear()
    finish('synced')
    await advance(120_000)

    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('stops a relay whose dispatch has settled', async () => {
    const { tick } = scripted(['synced', 'ended'])
    const relays = new FederationRelayScheduler(tick)
    relays.arm('dispatch-1', 'env-1')
    await advance(120_000)

    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('retries at once and from the base cadence when its server turns verified', async () => {
    const { tick, calls } = scripted(['failed', 'failed', 'failed', 'failed', 'failed'])
    const relays = new FederationRelayScheduler(tick)
    relays.arm('dispatch-1', 'env-1')
    relays.arm('dispatch-2', 'env-2')
    await advance(2_000 + 4_000)
    const before = tick.mock.calls.length

    relays.resetEnvironment('env-1')
    await advance(0)
    expect(tick.mock.calls.length).toBe(before + 1)
    expect(tick).toHaveBeenLastCalledWith('dispatch-1')
    // Reset failures, so the failed retry waits 2 s rather than 8 s.
    await advance(2_000)
    expect(calls.filter((at) => at === 8_000)).toHaveLength(1)
    relays.clear()
  })
  it.each([7, 70])(
    'bounds syncs for %i always-failing dispatches to the ramp plus one per minute',
    async (dispatchCount) => {
      const tick = vi.fn(async (): Promise<FederationRelayTickOutcome> => 'failed')
      const relays = new FederationRelayScheduler(tick)
      for (let index = 0; index < dispatchCount; index += 1) {
        relays.arm(`dispatch-${index}`, 'env-1')
      }
      await advance(10 * 60_000)

      // Each dispatch needs at most the 2^n ramp to the 60 s cap (6 steps) plus one retry per minute.
      expect(tick.mock.calls.length).toBeLessThanOrEqual(dispatchCount * (6 + 10))
      relays.clear()
    }
  )
})
