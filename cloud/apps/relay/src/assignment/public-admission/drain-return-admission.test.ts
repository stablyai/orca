import { describe, expect, it } from 'vitest'
import {
  RelayDrainReturnAdmission,
  type DrainReturnDeferral,
  type DrainReturnGrant
} from './drain-return-admission.js'
import { RelayPublicAssignmentAdmission } from './public-assignment-admission.js'

function harness(
  overrides: {
    maxQueued?: number
  } = {}
) {
  const placement = new RelayPublicAssignmentAdmission({
    maxConcurrent: 2,
    maxQueued: 8,
    waitMs: 4_000,
    minIntervalMs: 5_000,
    maxDrainReturnConcurrent: 1,
    maxDrainReturnQueued: overrides.maxQueued ?? 0,
    drainReturnWaitMs: 3_000,
    drainReturnMinIntervalMs: 2_000,
    now: () => 0,
    schedule: () => () => undefined
  })
  const lane = new RelayDrainReturnAdmission(placement, {
    maxConcurrent: 1,
    maxRetryAfterSeconds: 300,
    now: () => 0
  })
  return {
    lane,
    placement
  }
}

function admitted(result: DrainReturnGrant | DrainReturnDeferral): DrainReturnGrant {
  if (result.kind !== 'admitted') throw new Error(`expected admission, got ${result.reason}`)
  return result
}

const host = (index: number): string => `host${String(index).padStart(12, '0')}`

describe('drain-return admission', () => {

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
