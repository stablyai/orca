import { describe, expect, it } from 'vitest'
import type { DeviceEntry } from './device-entry'
import { droppedDelegatedPhones } from './delegated-mobile-devices'

function child(deviceId: string, parentDeviceId: string, phoneKey: string, origin?: string) {
  return {
    deviceId,
    name: deviceId,
    scope: 'mobile',
    pairedAt: 1,
    lastSeenAt: 1,
    parentDeviceId,
    phoneKey,
    ...(origin ? { originClientInstanceId: origin } : {})
  } satisfies DeviceEntry
}

// Desktops A and B share row `shared`; A also left children under the row it had before a re-pair.
const devices: DeviceEntry[] = [
  { deviceId: 'shared', name: 'shared', scope: 'runtime', pairedAt: 1, lastSeenAt: 1 },
  child('a-kept', 'shared', 'a1', 'A'),
  child('a-unpaired', 'shared', 'a2', 'A'),
  child('b-phone', 'shared', 'b1', 'B'),
  child('a-old-row', 'old', 'a3', 'A'),
  child('unclaimed', 'shared', 'x1'),
  child('unclaimed-old-row', 'old', 'x2')
]

describe('droppedDelegatedPhones', () => {
  it("drops only the syncing installation's unwanted phones, on any row", () => {
    const dropped = droppedDelegatedPhones(devices, 'shared', [{ phoneKey: 'a1', name: 'P' }], 'A')
    expect(dropped.map((device) => device.deviceId)).toEqual([
      'a-unpaired',
      'a-old-row',
      'unclaimed'
    ])
  })

  it('never drops a claimed phone when the sync names no installation', () => {
    const dropped = droppedDelegatedPhones(devices, 'shared', [], undefined)
    expect(dropped.map((device) => device.deviceId)).toEqual(['unclaimed'])
  })
})
