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
    // Legacy registries held phones only; missing scope must not grant CLI powers.
    scope: device.scope === 'runtime' ? 'runtime' : 'mobile',
    grants: validGrants(device.grants, device.scope === 'runtime' ? 'runtime' : 'mobile'),
    relayBinding: validRelayBinding(device.relayBinding, device.deviceId),
    mobilePairingConnectionMode:
      device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic',
    // Older grants reached the network; preserve all-interface binding on reconnect.
    pairingReach: device.pairingReach === 'this-computer' ? 'this-computer' : 'network',
    // Bad push metadata must not fail registry load and strand all devices.
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

// Malformed keyed rows stay keyed and unauthenticatable; never fall back to bearer auth.
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
