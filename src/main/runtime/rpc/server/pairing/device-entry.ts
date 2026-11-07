import type { DeviceScope } from '../../../../../shared/runtime-session-contracts'
import {
  parseMobilePairingConnectionMode,
  type MobilePairingConnectionMode
} from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import type { MobilePushRegistration } from '../../../../../shared/mobile-push-contract'
import type { RuntimePairingReach } from '../../../../../shared/runtime-pairing-reach'
import type { RelayDeviceBinding } from '../../../mobile-cloud-relay/relay-revoke-outbox'
import type { RuntimeDeviceGrant } from '../../rpc-method-permission'
import type { NetworkSourceClass } from '../../network-source-class'

export type DeviceEntry = {
  deviceId: string
  name: string
  // Keyed rows have no bearer, so older builds cannot authenticate them.
  token?: string
  scope: DeviceScope
  pairedAt: number
  lastSeenAt: number
  // Where its latest direct (non-Relay) connection came from; absent until one after this field shipped.
  lastSourceClass?: NetworkSourceClass
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
  // A never-seen offer stops authenticating here; absent (older rows, headless offers) never expires.
  offerExpiresAt?: number
  // Last sign-in used the older E2EE framing (set then; a v2 sign-in clears it). Local-only notice data.
  legacyE2EEAuthAt?: number
}

export type TokenDeviceEntry = DeviceEntry & { token: string }

export type DeviceKeyLookup =
  | { kind: 'found'; device: DeviceEntry & { devicePublicKeyB64: string } }
  | { kind: 'unknown' }
  // An unusable key is not revocation evidence.
  | { kind: 'not-keyed' }
  | { kind: 'refused' }
  | { kind: 'unavailable' }

// Only unscanned token rows are rotatable pairing offers; keyed rows never are.
export function isPendingTokenRow(device: DeviceEntry): device is TokenDeviceEntry {
  return (
    device.lastSeenAt === 0 && device.token !== undefined && device.credentialKind === undefined
  )
}

export function isExpiredPairingOffer(device: DeviceEntry, now: number): boolean {
  return (
    device.lastSeenAt === 0 && device.offerExpiresAt !== undefined && device.offerExpiresAt <= now
  )
}

export function sameGrants(entry: DeviceEntry, grants: readonly RuntimeDeviceGrant[]): boolean {
  const current = entry.grants ?? []
  return current.length === grants.length && current.every((grant) => grants.includes(grant))
}

// Clients erase keys on unknown; reserve that verdict for readable absence.
export function lookupDeviceKeyRow(
  device: DeviceEntry | null,
  devices: readonly DeviceEntry[]
): DeviceKeyLookup {
  if (!device) {
    return { kind: 'unknown' }
  }
  if (device.credentialKind !== 'device-key' || !device.devicePublicKeyB64) {
    return { kind: 'not-keyed' }
  }
  return withPairedParent(device, devices)
    ? { kind: 'found', device: { ...device, devicePublicKeyB64: device.devicePublicKeyB64 } }
    : { kind: 'refused' }
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

// Forks and delegated phones lose authority with any ancestor pairing.
function withPairedParent(
  device: DeviceEntry,
  devices: readonly DeviceEntry[],
  ancestors = new Set<string>()
): DeviceEntry | null {
  if (ancestors.has(device.deviceId)) {
    return null
  }
  ancestors.add(device.deviceId)
  const paired = [device.parentDeviceId, device.forkedFrom].every((parentId) => {
    if (parentId === undefined) {
      return true
    }
    const parent = devices.find((candidate) => candidate.deviceId === parentId)
    return parent !== undefined && withPairedParent(parent, devices, ancestors) !== null
  })
  ancestors.delete(device.deviceId)
  return paired ? device : null
}

export function findTokenDevice(
  devices: readonly DeviceEntry[],
  token: string,
  // Sightings whose persist failed still count, or a connected client would be locked out.
  seen: ReadonlySet<string> = new Set(),
  now = Date.now()
): DeviceEntry | null {
  const device = token && devices.find((d) => d.credentialKind === undefined && d.token === token)
  if (!device || (isExpiredPairingOffer(device, now) && !seen.has(device.deviceId))) {
    return null
  }
  return withPairedParent(device, devices)
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

/** Normalize mobile grants' saved mode; non-mobile grants have no mobile transport policy. */
export function mobilePairingConnectionModeOf(
  device: DeviceEntry | null
): MobilePairingConnectionMode | null {
  if (device?.scope !== 'mobile') {
    return null
  }
  // Legacy pairings used automatic direct-first Relay fallback.
  return parseMobilePairingConnectionMode(device.mobilePairingConnectionMode)
}
