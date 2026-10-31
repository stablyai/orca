import { randomBytes, randomUUID } from 'node:crypto'
import type { DeviceScope } from '../../shared/runtime-types'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { TokenDeviceEntry } from './device-entry'
import { validGrants } from './device-registry-row-validation'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'

export function mintDeviceCredential(): { deviceId: string; token: string } {
  return { deviceId: randomUUID(), token: randomBytes(24).toString('hex') }
}

/** A never-seen token row; it authenticates only once the registry persists it. */
export function mintTokenDevice(
  name: string,
  scope: DeviceScope,
  pairingReach: RuntimePairingReach,
  grants: readonly RuntimeDeviceGrant[]
): TokenDeviceEntry {
  const validatedGrants = validGrants(grants, scope)
  return {
    ...mintDeviceCredential(),
    name,
    scope,
    pairedAt: Date.now(),
    lastSeenAt: 0,
    pairingReach,
    ...(validatedGrants ? { grants: validatedGrants } : {})
  }
}
