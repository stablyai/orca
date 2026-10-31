import type { DeviceScope } from '../../shared/runtime-types'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { MobilePushRegistration } from '../../shared/mobile-push-contract'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { RelayDeviceBinding } from './mobile-cloud-relay/relay-revoke-outbox'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'

export type DeviceEntry = {
  deviceId: string
  name: string
  // Keyed rows have no bearer, so older builds cannot authenticate them.
  token?: string
  scope: DeviceScope
  pairedAt: number
  lastSeenAt: number
  relayBinding?: RelayDeviceBinding
  mobilePairingConnectionMode?: MobilePairingConnectionMode
  // STA-2370: local-only grants prove no off-host reach for listener binding.
  pairingReach?: RuntimePairingReach
  // Persist push across desktop restart; older registries have none.
  pushRegistration?: MobilePushRegistration
  // Relayed phones lose access with their parent desktop grant.
  parentDeviceId?: string
  phoneKey?: string
  // Grant only at pairing; absent on older rows means no administrative powers.
  grants?: RuntimeDeviceGrant[]
  // Credential changes invalidate bound sockets; absent revision is 0.
  credentialRevision?: number
  // Preserve orchestration ownership across credential change; absent defaults to sha256(token).
  callerFingerprint?: string
  // Absent means bearer row; device-key rows require this public key's proof.
  credentialKind?: 'device-key'
  devicePublicKeyB64?: string
  // The token row this installation migrated from; that row stays for its other holders.
  forkedFrom?: string
  // Session-only browser key (memory only); the row is dropped on host restart and after idling.
  ephemeral?: true
}

export type TokenDeviceEntry = DeviceEntry & { token: string }

export type DeviceKeyLookup =
  | { kind: 'found'; device: DeviceEntry & { devicePublicKeyB64: string } }
  | { kind: 'unknown' }
  // An unusable key is not revocation evidence.
  | { kind: 'not-keyed' }
  | { kind: 'unavailable' }

// Only unscanned token rows are rotatable pairing offers; keyed rows never are.
export function isPendingTokenRow(device: DeviceEntry): device is TokenDeviceEntry {
  return (
    device.lastSeenAt === 0 && device.token !== undefined && device.credentialKind === undefined
  )
}

export function sameGrants(entry: DeviceEntry, grants: readonly RuntimeDeviceGrant[]): boolean {
  const current = entry.grants ?? []
  return current.length === grants.length && current.every((grant) => grants.includes(grant))
}

// Clients erase keys on unknown; reserve that verdict for readable absence.
export function lookupDeviceKeyRow(device: DeviceEntry | null): DeviceKeyLookup {
  if (!device) {
    return { kind: 'unknown' }
  }
  return device.credentialKind === 'device-key' && device.devicePublicKeyB64
    ? { kind: 'found', device: { ...device, devicePublicKeyB64: device.devicePublicKeyB64 } }
    : { kind: 'not-keyed' }
}

export type AuthenticatedPrincipalBinding = {
  deviceId: string
  credentialRevision: number
  deviceToken?: string
}

export function isStillAuthenticated(
  device: DeviceEntry,
  principal: AuthenticatedPrincipalBinding
): boolean {
  return (
    (device.credentialRevision ?? 0) === principal.credentialRevision &&
    (principal.deviceToken === undefined || device.token === principal.deviceToken) &&
    // A keyed socket cannot survive replacement by a bearer row.
    (principal.deviceToken !== undefined || device.credentialKind === 'device-key')
  )
}

/** A delegated child authenticates only while its parent desktop is still paired. */
function withPairedParent(
  device: DeviceEntry,
  devices: readonly DeviceEntry[]
): DeviceEntry | null {
  const { parentDeviceId } = device
  return parentDeviceId === undefined || devices.some((d) => d.deviceId === parentDeviceId)
    ? device
    : null
}

export function findTokenDevice(
  devices: readonly DeviceEntry[],
  token: string
): DeviceEntry | null {
  const device = token && devices.find((d) => d.credentialKind === undefined && d.token === token)
  return device ? withPairedParent(device, devices) : null
}

export function findPrincipalDevice(
  devices: readonly DeviceEntry[],
  principal: AuthenticatedPrincipalBinding
): DeviceEntry | null {
  const device = devices.find((d) => d.deviceId === principal.deviceId)
  return device && isStillAuthenticated(device, principal)
    ? withPairedParent(device, devices)
    : null
}

export function mobilePairingConnectionModeOf(
  device: DeviceEntry | null
): MobilePairingConnectionMode | null {
  if (device?.scope !== 'mobile') {
    return null
  }
  // Legacy pairings used automatic direct-first Relay fallback.
  return device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic'
}
