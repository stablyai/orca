import type { DeviceScope } from '../../shared/runtime-types'
import type { RelayDeviceBinding } from './mobile-cloud-relay/relay-revoke-outbox'
import type { DeviceEntry } from './device-registry'
import { parseMobilePushRegistration } from '../../shared/mobile-push-contract'
import { isDevicePublicKeyB64 } from '../../shared/device-key-proof'
import { RUNTIME_DEVICE_GRANTS, type RuntimeDeviceGrant } from './rpc/rpc-method-permission'

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
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const binding = value as Partial<RelayDeviceBinding>
  return binding.relayDeviceId === deviceId &&
    typeof binding.relayHostId === 'string' &&
    typeof binding.ownerIdentityKey === 'string'
    ? {
        relayHostId: binding.relayHostId,
        relayDeviceId: binding.relayDeviceId,
        ownerIdentityKey: binding.ownerIdentityKey,
        ...(typeof binding.inviteExpiresAt === 'number' && Number.isFinite(binding.inviteExpiresAt)
          ? { inviteExpiresAt: binding.inviteExpiresAt }
          : {})
      }
    : undefined
}

export function normalizeLoadedDeviceRow(device: DeviceEntry): DeviceEntry {
  return {
    ...device,
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
  device: DeviceEntry
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
