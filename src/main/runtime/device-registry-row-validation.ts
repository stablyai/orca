import type { DeviceScope } from '../../shared/runtime-types'
import type { RelayDeviceBinding } from './mobile-cloud-relay/relay-revoke-outbox'
import type { DeviceEntry } from './device-registry'
import { parseMobilePushRegistration } from '../../shared/mobile-push-contract'
import { isDevicePublicKeyB64 } from '../../shared/device-key-proof'
import { RUNTIME_DEVICE_GRANTS, type RuntimeDeviceGrant } from './rpc/rpc-method-permission'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'

const GRANTABLE: ReadonlySet<string> = new Set(RUNTIME_DEVICE_GRANTS)

function isRuntimeDeviceGrant(value: unknown): value is RuntimeDeviceGrant {
  return typeof value === 'string' && GRANTABLE.has(value)
}

export function validGrants(value: unknown, scope: DeviceScope): RuntimeDeviceGrant[] | undefined {
  if (scope !== 'runtime' || !Array.isArray(value)) {
    return undefined
  }
  const grants = [...new Set(value.filter(isRuntimeDeviceGrant))].sort()
  return grants.length > 0 ? grants : undefined
}

export function validRelayBinding(
  value: unknown,
  deviceId: string
): RelayDeviceBinding | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  return value.relayDeviceId === deviceId &&
    typeof value.relayHostId === 'string' &&
    typeof value.ownerIdentityKey === 'string'
    ? {
        relayHostId: value.relayHostId,
        relayDeviceId: deviceId,
        ownerIdentityKey: value.ownerIdentityKey,
        ...(typeof value.inviteExpiresAt === 'number' && Number.isFinite(value.inviteExpiresAt)
          ? { inviteExpiresAt: value.inviteExpiresAt }
          : {})
      }
    : undefined
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Null for a row without a usable identity; the caller must treat the registry as doubtful. */
export function normalizeLoadedDeviceRow(device: unknown): DeviceEntry | null {
  if (
    !isRecord(device) ||
    typeof device.deviceId !== 'string' ||
    !device.deviceId ||
    !isTimestamp(device.pairedAt) ||
    !isTimestamp(device.lastSeenAt)
  ) {
    return null
  }
  return {
    ...device,
    deviceId: device.deviceId,
    name: typeof device.name === 'string' ? device.name : '',
    // Why: a non-string bearer can never match, so the row stays listed but inert.
    token: typeof device.token === 'string' ? device.token : undefined,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
    // Why: older registries only existed for phone pairing. Treat missing
    // scope as mobile so legacy device tokens do not gain new CLI powers.
    scope: device.scope === 'runtime' ? 'runtime' : 'mobile',
    grants: validGrants(device.grants, device.scope === 'runtime' ? 'runtime' : 'mobile'),
    relayBinding: validRelayBinding(device.relayBinding, device.deviceId),
    mobilePairingConnectionMode:
      device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic',
    // Why: registries written before this field existed only ever held network-reach grants (phones and
    // LAN links), so a missing value must keep binding every interface on reconnect.
    pairingReach: device.pairingReach === 'this-computer' ? 'this-computer' : 'network',
    // Why: a malformed row must degrade to "no background push", never fail the load
    // and strand every paired device.
    pushRegistration: parseMobilePushRegistration(device.pushRegistration),
    parentDeviceId: typeof device.parentDeviceId === 'string' ? device.parentDeviceId : undefined,
    phoneKey: typeof device.phoneKey === 'string' ? device.phoneKey : undefined,
    credentialRevision:
      typeof device.credentialRevision === 'number' &&
      Number.isSafeInteger(device.credentialRevision) &&
      device.credentialRevision > 0
        ? device.credentialRevision
        : undefined,
    callerFingerprint:
      typeof device.callerFingerprint === 'string' && device.callerFingerprint.length > 0
        ? device.callerFingerprint
        : undefined,
    ...validDeviceKeyFields(device)
  }
}

// Why: a malformed keyed row stays keyed (so it never falls back to a token) but cannot authenticate.
function validDeviceKeyFields(
  device: Record<string, unknown>
): Pick<DeviceEntry, 'credentialKind' | 'devicePublicKeyB64' | 'forkedFrom' | 'ephemeral'> {
  if (device.credentialKind !== 'device-key') {
    return {
      credentialKind: undefined,
      devicePublicKeyB64: undefined,
      forkedFrom: undefined,
      ephemeral: undefined
    }
  }
  return {
    credentialKind: 'device-key',
    devicePublicKeyB64: isDevicePublicKeyB64(device.devicePublicKeyB64)
      ? device.devicePublicKeyB64
      : undefined,
    forkedFrom: typeof device.forkedFrom === 'string' ? device.forkedFrom : undefined,
    ephemeral: device.ephemeral === true ? true : undefined
  }
}
