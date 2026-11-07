import { describe, expect, it } from 'vitest'
import type { DeviceEntry } from './device-entry'
import { usesLegacyE2EE, withDeviceSighting } from './device-sighting'

const device: DeviceEntry = {
  deviceId: 'phone-1',
  name: 'Phone',
  token: 'token',
  scope: 'mobile',
  pairedAt: 1,
  lastSeenAt: 2
}

describe('device sightings and the older-encryption notice', () => {
  it('flags a legacy sign-in and clears it on the next v2 sign-in', () => {
    const legacy = withDeviceSighting(device, 10, 'legacy')
    expect(legacy).toMatchObject({ lastSeenAt: 10, legacyE2EEAuthAt: 10 })
    expect(usesLegacyE2EE(legacy)).toBe(true)

    const disconnected = withDeviceSighting(legacy, 11)
    expect(usesLegacyE2EE(disconnected)).toBe(true)

    const upgraded = withDeviceSighting(disconnected, 12, 'v2')
    expect(upgraded).toEqual({ ...device, lastSeenAt: 12 })
    expect(usesLegacyE2EE(upgraded)).toBe(false)
  })
})
