import { mintDeviceCredential } from './device-credential'
import { devicePrincipalOf } from './device-principal'
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
      (device): device is DeviceEntry & { parentDeviceId: string; phoneKey: string } =>
        device.parentDeviceId === parent.deviceId && device.phoneKey === phone.phoneKey
    )
    if (existing) {
      const origin = originClientInstanceId ?? existing.originClientInstanceId
      if (
        existing.name === phone.name &&
        existing.token !== undefined &&
        existing.originClientInstanceId === origin
      ) {
        return { ...existing, token: existing.token }
      }
      // The file keeps only the token's hash, so a child minted before this process started gets a
      // new one; the parent syncs after reconnecting to a restarted host, so it takes it then.
      const { token, tokenHash } = existing.token
        ? { token: existing.token, tokenHash: existing.tokenHash }
        : mintDeviceCredential()
      const updated: DelegatedMobileDeviceEntry = {
        ...existing,
        name: phone.name,
        ...(origin ? { originClientInstanceId: origin } : {}),
        token,
        tokenHash,
        ...(existing.token
          ? {}
          : {
              callerFingerprint: devicePrincipalOf(existing).callerFingerprint,
              credentialRevision: (existing.credentialRevision ?? 0) + 1
            })
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
