import { describe, expect, it } from 'vitest'
import { FilesystemHostBreaker } from './filesystem-host-breaker'

describe('FilesystemHostBreaker', () => {
  it('admits one recovery probe and reopens after a failed probe', () => {
    const breaker = new FilesystemHostBreaker(1_000)
    breaker.recordFailure(100)

    expect(breaker.admit(1_099)).toEqual({ allowed: false, probe: false })
    expect(breaker.admit(1_100)).toEqual({ allowed: true, probe: true })
    expect(breaker.admit(1_100)).toEqual({ allowed: false, probe: false })

    breaker.recordFailure(1_100)
    expect(breaker.admit(2_099)).toEqual({ allowed: false, probe: false })
    expect(breaker.admit(2_100)).toEqual({ allowed: true, probe: true })
    breaker.recordSuccess(true)
    expect(breaker.admit(2_100)).toEqual({ allowed: true, probe: false })
  })

  it('defers a probe rejected by process-wide capacity without blaming the lane', () => {
    const breaker = new FilesystemHostBreaker(1_000)
    breaker.recordFailure(100)

    expect(breaker.admit(1_100)).toEqual({ allowed: true, probe: true })
    breaker.deferProbe()
    expect(breaker.admit(1_100)).toEqual({ allowed: true, probe: true })
  })
})
