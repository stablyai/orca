import { describe, expect, it } from 'vitest'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'

const options = {
  directSuccessesRequired: 3,
  directObservationMs: 30_000,
  failureCooldownMs: 60_000,
  minimumDwellMs: 60_000
}

describe('mobile endpoint hysteresis', () => {
  it('requires three authenticated direct successes across the observation and dwell windows', () => {
    const policy = new MobileEndpointHysteresis(0, options)

    expect(policy.recordDirectSuccess(60_000)).toBe(false)
    expect(policy.recordDirectSuccess(75_000)).toBe(false)
    expect(policy.recordDirectSuccess(90_000)).toBe(true)
  })

  it('resets progress and observes cooldown after a failure', () => {
    const policy = new MobileEndpointHysteresis(0, options)
    policy.recordDirectSuccess(60_000)
    policy.recordDirectFailure(61_000)

    expect(policy.canProbe(120_999)).toBe(false)
    expect(policy.canProbe(121_000)).toBe(true)
    expect(policy.recordDirectSuccess(121_000)).toBe(false)
    expect(policy.recordDirectSuccess(136_000)).toBe(false)
    expect(policy.recordDirectSuccess(151_000)).toBe(true)
  })
})
