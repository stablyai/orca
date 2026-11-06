import { describe, expect, it } from 'vitest'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'

describe('mobile endpoint hysteresis', () => {
  it('requires three authenticated direct successes across the observation and dwell windows', () => {
    const policy = new MobileEndpointHysteresis(0)

    expect(policy.recordDirectSuccess(60_000)).toBe(false)
    expect(policy.recordDirectSuccess(75_000)).toBe(false)
    expect(policy.recordDirectSuccess(90_000)).toBe(true)

    const insufficientSamples = new MobileEndpointHysteresis(0)
    expect(insufficientSamples.recordDirectSuccess(60_000)).toBe(false)
    expect(insufficientSamples.recordDirectSuccess(90_000)).toBe(false)
    expect(insufficientSamples.recordDirectSuccess(90_000)).toBe(true)

    const shortObservation = new MobileEndpointHysteresis(0)
    expect(shortObservation.recordDirectSuccess(60_000)).toBe(false)
    expect(shortObservation.recordDirectSuccess(60_001)).toBe(false)
    expect(shortObservation.recordDirectSuccess(60_002)).toBe(false)
    expect(shortObservation.recordDirectSuccess(90_000)).toBe(true)

    const shortDwell = new MobileEndpointHysteresis(0)
    expect(shortDwell.recordDirectSuccess(0)).toBe(false)
    expect(shortDwell.recordDirectSuccess(15_000)).toBe(false)
    expect(shortDwell.recordDirectSuccess(30_000)).toBe(false)
    expect(shortDwell.recordDirectSuccess(60_000)).toBe(true)
  })

  it('resets progress and observes cooldown after a failure', () => {
    const policy = new MobileEndpointHysteresis(0)
    policy.recordDirectSuccess(60_000)
    policy.recordDirectFailure(61_000)

    expect(policy.canProbe(120_999)).toBe(false)
    expect(policy.canProbe(121_000)).toBe(true)
    expect(policy.recordDirectSuccess(121_000)).toBe(false)
    expect(policy.recordDirectSuccess(136_000)).toBe(false)
    expect(policy.recordDirectSuccess(151_000)).toBe(true)
  })
  it('upgrades after two successes 3 s apart within the dwell once the phone joins a network', () => {
    const policy = new MobileEndpointHysteresis(0)
    policy.recordDirectFailure(10_000)
    expect(policy.canProbe(20_000)).toBe(false)

    policy.recordNetworkArrival(20_000)
    expect(policy.canProbe(20_000)).toBe(true)
    // The network change drops the relay socket, and its redial is a migration too.
    policy.recordMigration(20_000)
    expect(policy.recordDirectSuccess(20_000)).toBe(false)
    expect(policy.recordDirectSuccess(22_999)).toBe(false)
    expect(policy.recordDirectSuccess(23_000)).toBe(true)
  })

  it('needs three timer successes again after an arrival fails or upgrades, and refuses another arrival within the dwell', () => {
    const failed = new MobileEndpointHysteresis(0)
    failed.recordNetworkArrival(0)
    failed.recordDirectFailure(0)
    expect(failed.recordDirectSuccess(60_000)).toBe(false)
    expect(failed.recordDirectSuccess(63_000)).toBe(false)
    expect(failed.recordDirectSuccess(90_000)).toBe(true)

    const upgraded = new MobileEndpointHysteresis(0)
    upgraded.recordNetworkArrival(0)
    upgraded.recordDirectSuccess(0)
    expect(upgraded.recordDirectSuccess(3_000)).toBe(true)
    upgraded.recordMigration(3_000)
    upgraded.recordMigration(10_000)
    // Wi-Fi at the edge of range rejoins within the dwell; that arrival is refused.
    expect(upgraded.recordNetworkArrival(10_000)).toBe(false)
    expect(upgraded.recordDirectSuccess(10_000)).toBe(false)
    expect(upgraded.recordDirectSuccess(13_000)).toBe(false)
    expect(upgraded.recordDirectSuccess(40_000)).toBe(false)
    expect(upgraded.recordDirectSuccess(70_000)).toBe(true)
  })
})
