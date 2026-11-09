import { describe, expect, it } from 'vitest'
import {
  HostedSandboxConfigResponseSchema,
  ORCA_CLOUD_IDLE_SLEEP_MINUTES
} from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { DEFAULT_PLANS } from '../../billing/src/plans'
import { cachedCreateTiming, MIN_TIMING_SAMPLES, summarizeStartTimes } from '../src/create-timing'
import { createHarness } from './harness'

describe('GET /v1/config', () => {
  it('serves the idle-sleep minutes every client reads; billing advertises the same constant', async () => {
    const h = await createHarness()
    const res = await h.send(new Request('https://sandbox.test/v1/config'))
    expect(res.status).toBe(200)
    const body = HostedSandboxConfigResponseSchema.parse(await res.json())
    expect(body.idleSleepMinutes).toBe(ORCA_CLOUD_IDLE_SLEEP_MINUTES)
    expect(DEFAULT_PLANS.team.idleSleepMinutes).toBe(ORCA_CLOUD_IDLE_SLEEP_MINUTES)
    // No sandbox has started yet, so there is no measured start time to advertise.
    expect(body.createTiming).toBeUndefined()
  })

  it('advertises the measured start time once enough sandboxes have started', async () => {
    const h = await createHarness()
    for (let index = 0; index < MIN_TIMING_SAMPLES; index++) {
      const created = await h.call('POST', '/v1/sandboxes', {
        body: { workspaceId: `ws-${index}`, machineSize: 'standard' },
        // One per user: the per-member running limit would refuse the fourth.
        as: `user-${index}`
      })
      expect(created.status).toBe(200)
    }
    const body = HostedSandboxConfigResponseSchema.parse(
      await (await h.send(new Request('https://sandbox.test/v1/config'))).json()
    )
    expect(body.createTiming?.samples).toBe(MIN_TIMING_SAMPLES)
  })
})

describe('summarizeStartTimes', () => {
  it('reports p50 and p95 and drops gaps that are later wakes, not starts', () => {
    const starts = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000, 3_600_000]
    expect(summarizeStartTimes(starts)).toEqual({ p50Ms: 5000, p95Ms: 10_000, samples: 10 })
  })

  it('shows no timing from too few starts', () => {
    expect(summarizeStartTimes([1000, 2000])).toBeUndefined()
  })
})

describe('cachedCreateTiming', () => {
  it('reads D1 at most once per 5 minutes, and retries after a failed read', async () => {
    let reads = 0
    let fail = true
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            reads++
            if (fail) {
              throw new Error('d1 down')
            }
            return { results: [] }
          }
        })
      })
    } as unknown as D1Database
    expect(await cachedCreateTiming(db, 0)).toBeUndefined()
    fail = false
    await cachedCreateTiming(db, 1_000)
    await cachedCreateTiming(db, 2_000)
    expect(reads).toBe(2)
    await cachedCreateTiming(db, 1_000 + 5 * 60_000)
    expect(reads).toBe(3)
  })
})
