import { mintDeviceCredential } from './device-credential'
import type { DelegatedPhone } from '../../shared/delegated-mobile-device-contract'
import type { DeviceEntry } from './device-registry'

export type DelegatedMobileDeviceEntry = DeviceEntry & { parentDeviceId: string; phoneKey: string }

/** The registry after making `parent`'s children cover `phones`, and those children in `phones` order. */
export function planDelegatedMobileDevices(
  devices: DeviceEntry[],
  parent: DeviceEntry,
  phones: readonly DelegatedPhone[],
  now = Date.now()
): { nextDevices: DeviceEntry[]; entries: DelegatedMobileDeviceEntry[] } {
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
      // Why: never pending — the QR lookups select lastSeenAt === 0 and must not hand out or rotate a child.
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
