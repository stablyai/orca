import { describe, expect, it } from 'vitest'
import {
  DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS,
  RelayDrainReturnAdmission,
  type DrainReturnDeferral,
  type DrainReturnGrant
} from './drain-return-admission.js'
import { RelayPublicAssignmentAdmission } from './public-assignment-admission.js'

type Timer = { at: number; callback: () => void; cancelled: boolean }

function harness(
  overrides: {
    maxQueued?: number
    maxRetryAfterSeconds?: number
    onServiceMs?: (durationMs: number) => void
  } = {}
) {
  let now = 0
  const timers: Timer[] = []
  const placement = new RelayPublicAssignmentAdmission({
    maxConcurrent: 2,
    maxQueued: 8,
    waitMs: 4_000,
    minIntervalMs: 5_000,
    maxDrainReturnConcurrent: 1,
    maxDrainReturnQueued: overrides.maxQueued ?? 0,
    drainReturnWaitMs: 3_000,
    drainReturnMinIntervalMs: DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS * 1_000,
    now: () => now,
    schedule: (callback, delayMs) => {
      const timer = { at: now + delayMs, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    }
  })
  const lane = new RelayDrainReturnAdmission(placement, {
    maxConcurrent: 1,
    maxRetryAfterSeconds: overrides.maxRetryAfterSeconds ?? 300,
    now: () => now,
    onServiceMs: overrides.onServiceMs
  })
  return {
    lane,
    placement,
    advance: (ms: number) => {
      now += ms
      for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= now)) {
        timer.cancelled = true
        timer.callback()
      }
    }
  }
}

function admitted(result: DrainReturnGrant | DrainReturnDeferral): DrainReturnGrant {
  if (result.kind !== 'admitted') throw new Error(`expected admission, got ${result.reason}`)
  return result
}

function deferred(result: DrainReturnGrant | DrainReturnDeferral): DrainReturnDeferral {
  if (result.kind !== 'deferred') throw new Error('expected a deferral')
  return result
}

const host = (index: number): string => `host${String(index).padStart(12, '0')}`

describe('drain-return admission', () => {
  it('admits up to its concurrency and defers the rest with a paced Retry-After', async () => {
    const { lane } = harness()
    admitted(await lane.acquire(host(0)))

    const retries = []
    for (let index = 1; index <= 5; index++) {
      const deferral = deferred(await lane.acquire(host(index)))
      expect(deferral.reason).toBe('queue-full')
      retries.push(deferral.retryAfterSeconds)
    }

    // 860 ms per slot before any measurement: one host per slot, in order.
    expect(retries).toEqual([2, 3, 4, 5, 6])
  })

  it('gives the same answers to the same arrivals', async () => {
    const run = async (): Promise<number[]> => {
      const { lane, advance } = harness({ maxQueued: 2 })
      const answers: number[] = []
      const settled: Promise<void>[] = []
      for (let index = 0; index < 40; index++) {
        settled.push(
          lane.acquire(host(index)).then((result) => {
            if (result.kind === 'deferred') answers.push(result.retryAfterSeconds)
          })
        )
        await Promise.resolve()
        advance(100)
      }
      advance(10_000)
      await Promise.all(settled.slice(1))
      return answers
    }

    const first = await run()
    expect(first).toHaveLength(39)
    expect(await run()).toEqual(first)
    expect(Math.min(...first)).toBeGreaterThanOrEqual(DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS)
  })

  it('never asks a host to wait longer than the configured ceiling', async () => {
    const { lane } = harness({ maxRetryAfterSeconds: 10 })
    admitted(await lane.acquire(host(0)))

    const retries = []
    for (let index = 1; index <= 50; index++) {
      retries.push(deferred(await lane.acquire(host(index))).retryAfterSeconds)
    }

    expect(Math.max(...retries)).toBe(10)
  })

  it('shortens the pacing once the measured service time is short', async () => {
    const { lane, advance } = harness()
    for (let index = 0; index < 30; index++) {
      const grant = admitted(await lane.acquire(host(index)))
      advance(50)
      grant.lease.release()
      advance(2_000)
    }
    admitted(await lane.acquire(host(100)))

    const retries = []
    for (let index = 101; index <= 120; index++) {
      retries.push(deferred(await lane.acquire(host(index))).retryAfterSeconds)
    }

    // ~50 ms per re-placement: twenty deferrals span about one second, where the
    // 860 ms starting estimate would have spread them over seventeen.
    expect(Math.max(...retries)).toBe(3)
  })

  // The unclamped sample: the EWMA's floor and ceiling would hide the real tail.
  it('reports each slot hold once, as measured', async () => {
    const samples: number[] = []
    const { lane, advance } = harness({ onServiceMs: (ms) => samples.push(ms) })
    const fast = admitted(await lane.acquire(host(1)))
    advance(5)
    fast.lease.release()
    fast.lease.release()
    const slow = admitted(await lane.acquire(host(2)))
    advance(20_000)
    slow.lease.release()

    expect(samples).toEqual([5, 20_000])
  })

  it('answers a host’s own early retry with its interval, not a place behind the cohort', async () => {
    const { lane } = harness()
    admitted(await lane.acquire(host(0))).lease.release()

    // A row-busy refusal says "retry in 1 s"; that redial is the host's own.
    const repeat = deferred(await lane.acquire(host(0)))
    expect(repeat).toMatchObject({
      reason: 'host-rate-limited',
      retryAfterSeconds: DRAIN_RETURN_MIN_RETRY_AFTER_SECONDS
    })

    // And it booked nothing: the next overflow still gets the first slot.
    admitted(await lane.acquire(host(1)))
    expect(deferred(await lane.acquire(host(2))).retryAfterSeconds).toBe(2)
  })

  it('keeps a host’s reserved slot when it comes back early', async () => {
    const { lane, advance } = harness()
    admitted(await lane.acquire(host(0)))
    for (let index = 1; index <= 4; index++) await lane.acquire(host(index))
    expect(deferred(await lane.acquire(host(5))).retryAfterSeconds).toBe(6)

    advance(1_000)
    // Early and still full: the same instant, not a new slot after everyone else.
    expect(deferred(await lane.acquire(host(5))).retryAfterSeconds).toBe(5)
  })

  it('never holds placement’s last permit', async () => {
    const { lane } = harness()
    admitted(await lane.acquire(host(0)))

    // One of two permits is still free, but it is placement's.
    expect(deferred(await lane.acquire(host(1))).reason).toBe('queue-full')
  })

  it('lets a queued placement go before a queued drain return', async () => {
    const { lane, placement } = harness({ maxQueued: 1 })
    const drain = admitted(await lane.acquire(host(0)))
    const first = await placement.acquire('placement000001')
    expect(first).not.toBeNull()

    const queuedPlacement = placement.acquire('placement000002')
    const queuedDrain = lane.acquire(host(1))
    drain.lease.release()
    const second = await queuedPlacement
    expect(second).not.toBeNull()

    first?.release()
    expect((await queuedDrain).kind).toBe('admitted')
    second?.release()
  })
})
