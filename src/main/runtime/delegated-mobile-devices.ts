import { mintDeviceCredential } from './device-credential'
import type { DelegatedPhone } from '../../shared/delegated-mobile-device-contract'
import type { DeviceEntry } from './device-registry'

export type DelegatedMobileDeviceEntry = DeviceEntry & {
  parentDeviceId: string
  phoneKey: string
  token: string
}

export function planDelegatedMobileDevices(
  devices: DeviceEntry[],
  parent: DeviceEntry,
  phones: readonly DelegatedPhone[],
  now = Date.now()
): { nextDevices: DeviceEntry[]; entries: DelegatedMobileDeviceEntry[] } {
  // A parent removed meanwhile (e.g. on disk) must not mint children nobody can revoke with it.
  if (!devices.some((device) => device.deviceId === parent.deviceId)) {
    return { nextDevices: devices, entries: [] }
  }
  let nextDevices = devices
  const entries = phones.map((phone) => {
    const existing = nextDevices.find(
      (device): device is DelegatedMobileDeviceEntry =>
        device.parentDeviceId === parent.deviceId && device.phoneKey === phone.phoneKey
    )
    if (existing) {
      if (existing.name === phone.name) {
        return existing
      }
      const renamed = { ...existing, name: phone.name }
      nextDevices = nextDevices.map((device) => (device === existing ? renamed : device))
      return renamed
    }
    const entry: DelegatedMobileDeviceEntry = {
      ...mintDeviceCredential(),
      name: phone.name,
      scope: 'mobile',
      pairedAt: now,
      // QR rotation targets lastSeenAt === 0; delegated children must never be pending offers.
      lastSeenAt: now,
      pairingReach: parent.pairingReach ?? 'network',
      parentDeviceId: parent.deviceId,
      phoneKey: phone.phoneKey
    }
    nextDevices = [...nextDevices, entry]
    return entry
  })
  return { nextDevices, entries }
}
