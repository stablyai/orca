import { mintDeviceCredential } from './device-credential'
import type { DelegatedPhone } from '../../../../../shared/remote-runtime/pairing/delegated-mobile-device-contract'
import type { DeviceEntry } from './device-entry'

export type DelegatedMobileDeviceEntry = DeviceEntry & {
  parentDeviceId: string
  phoneKey: string
  token: string
}

export function planDelegatedMobileDevices(
  devices: DeviceEntry[],
  parent: DeviceEntry,
  phones: readonly DelegatedPhone[],
  // The parent installation that synced: several desktops can share one parent row.
  originClientInstanceId?: string,
  now = Date.now()
): { nextDevices: DeviceEntry[]; entries: DelegatedMobileDeviceEntry[] } {
  // A parent removed meanwhile (e.g. on disk) must not mint children nobody can revoke with it.
  if (!devices.some((device) => device.deviceId === parent.deviceId)) {
    return { nextDevices: devices, entries: [] }
  }
  let nextDevices = devices
  const entries = phones.map((phone) => {
    const existing = nextDevices.find(
      (device) => device.parentDeviceId === parent.deviceId && device.phoneKey === phone.phoneKey
    )
    if (existing) {
      const origin = originClientInstanceId ?? existing.originClientInstanceId
      const { token } = existing
      if (
        token !== undefined &&
        existing.name === phone.name &&
        existing.originClientInstanceId === origin
      ) {
        return { ...existing, token, parentDeviceId: parent.deviceId, phoneKey: phone.phoneKey }
      }
      const updated: DelegatedMobileDeviceEntry = {
        ...existing,
        parentDeviceId: parent.deviceId,
        phoneKey: phone.phoneKey,
        name: phone.name,
        ...(origin ? { originClientInstanceId: origin } : {}),
        // A row a hash-storing build left has no token to hand the phone: mint it a new one.
        ...(token === undefined
          ? {
              token: mintDeviceCredential().token,
              credentialRevision: (existing.credentialRevision ?? 0) + 1
            }
          : { token })
      }
      nextDevices = nextDevices.map((device) => (device === existing ? updated : device))
      return updated
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
      phoneKey: phone.phoneKey,
      ...(originClientInstanceId ? { originClientInstanceId } : {})
    }
    nextDevices = [...nextDevices, entry]
    return entry
  })
  return { nextDevices, entries }
}

/** The children a sync from `parentDeviceId` revokes: unwanted ones of the syncing installation under
 *  any row (a re-paired desktop must still cut phones its old row minted), plus unwanted unclaimed
 *  ones under this row. Another installation's phones on a shared row are never touched. */
export function droppedDelegatedPhones(
  devices: readonly DeviceEntry[],
  parentDeviceId: string,
  phones: readonly DelegatedPhone[],
  originClientInstanceId: string | undefined
): DeviceEntry[] {
  const wanted = new Set(phones.map((phone) => phone.phoneKey))
  return devices.filter((child) => {
    if (child.parentDeviceId === undefined || (child.phoneKey && wanted.has(child.phoneKey))) {
      return false
    }
    const origin = child.originClientInstanceId
    return origin === undefined
      ? child.parentDeviceId === parentDeviceId
      : origin === originClientInstanceId
  })
}
