import type { DeviceScope } from '../../shared/runtime-types'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { MobilePushRegistration } from '../../shared/mobile-push-contract'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { RelayDeviceBinding } from './mobile-cloud-relay/relay-revoke-outbox'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'

export type DeviceEntry = {
  deviceId: string
  name: string
  // Why: token rows only; a keyed row has no bearer, so an older build finds nothing to match (inert).
  token?: string
  scope: DeviceScope
  pairedAt: number
  lastSeenAt: number
  relayBinding?: RelayDeviceBinding
  mobilePairingConnectionMode?: MobilePairingConnectionMode
  // Why: STA-2370 — a grant minted for "This computer only" proves nothing about off-host reach when its
  // client connects, so the bind decision must be able to tell it apart from a LAN/phone grant.
  pairingReach?: RuntimePairingReach
  // Why: survives a desktop restart so the host can keep pushing without the phone
  // re-registering. Absent on every registry written before background push existed.
  pushRegistration?: MobilePushRegistration
  // Why: a phone relayed by a paired desktop is that desktop's child; it dies with the parent's grant.
  parentDeviceId?: string
  phoneKey?: string
  // Why: administrative permissions are granted only when pairing; absent on older rows means none.
  grants?: RuntimeDeviceGrant[]
  // Why: authenticated sockets are bound to this; a credential change bumps it. Absent = 0.
  credentialRevision?: number
  // Why: orchestration ownership survives a credential change. Absent = sha256(token).
  callerFingerprint?: string
  // Why: absent = token row. A keyed row authenticates only by a proof from this public key.
  credentialKind?: 'device-key'
  devicePublicKeyB64?: string
  // The token row this installation migrated from; that row stays for its other holders.
  forkedFrom?: string
  // Session-only browser key (memory only); the row is dropped on host restart and after idling.
  ephemeral?: true
}

/** A row that authenticates by bearer token: every pairing offer and delegated child. */
export type TokenDeviceEntry = DeviceEntry & { token: string }

export type DeviceKeyLookup =
  | { kind: 'found'; device: DeviceEntry & { devicePublicKeyB64: string } }
  | { kind: 'unknown' }
  // The row exists but has no usable key: never a revocation verdict.
  | { kind: 'not-keyed' }
  | { kind: 'unavailable' }

// Why: a never-scanned token row is a pairing offer; keyed rows are never offers or rotated away.
export function isPendingTokenRow(device: DeviceEntry): device is TokenDeviceEntry {
  return (
    device.lastSeenAt === 0 && device.token !== undefined && device.credentialKind === undefined
  )
}

export function sameGrants(entry: DeviceEntry, grants: readonly RuntimeDeviceGrant[]): boolean {
  const current = entry.grants ?? []
  return current.length === grants.length && current.every((grant) => grants.includes(grant))
}

// Why: "unknown" must mean "readable and absent" — clients delete their key only on that verdict.
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
    // Why: a keyed socket must not survive its row turning back into (or being replaced by) a token row.
    (principal.deviceToken !== undefined || device.credentialKind === 'device-key')
  )
}

export function mobilePairingConnectionModeOf(
  device: DeviceEntry | null
): MobilePairingConnectionMode | null {
  if (device?.scope !== 'mobile') {
    return null
  }
  // Why: pairings created before this preference existed used automatic
  // direct-first Relay fallback, so missing state must preserve that behavior.
  return device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic'
}
