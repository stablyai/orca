import { describe, expect, it } from 'vitest'
import {
  HostedSandboxConfigResponseSchema,
  ORCA_CLOUD_IDLE_SLEEP_MINUTES
} from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import { DEFAULT_PLANS } from '../../billing/src/plans'
import { createHarness } from './harness'

describe('GET /v1/config', () => {
  it('serves the idle-sleep minutes every client reads; billing advertises the same constant', async () => {
    const h = await createHarness()
    const res = await h.send(new Request('https://sandbox.test/v1/config'))
    expect(res.status).toBe(200)
    const body = HostedSandboxConfigResponseSchema.parse(await res.json())
    expect(body.idleSleepMinutes).toBe(ORCA_CLOUD_IDLE_SLEEP_MINUTES)
    expect(DEFAULT_PLANS.team.idleSleepMinutes).toBe(ORCA_CLOUD_IDLE_SLEEP_MINUTES)
  })
})
