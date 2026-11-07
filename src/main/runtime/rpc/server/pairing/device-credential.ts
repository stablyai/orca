import { randomBytes, randomUUID } from 'node:crypto'
import type { DeviceScope } from '../../../../../shared/runtime-session-contracts'
import type { RuntimePairingReach } from '../../../../../shared/runtime-pairing-reach'
import type { TokenDeviceEntry } from './device-entry'
import { validGrants } from './device-registry-row-validation'
import type { RuntimeDeviceGrant } from '../../rpc-method-permission'

export function mintDeviceCredential(): { deviceId: string; token: string } {
  return { deviceId: randomUUID(), token: randomBytes(24).toString('hex') }
}

/** A never-seen token row; it authenticates only once the registry persists it. */
export function mintTokenDevice(
  name: string,
  scope: DeviceScope,
  pairingReach: RuntimePairingReach,
  grants: readonly RuntimeDeviceGrant[],
  offerTtlMs?: number
): TokenDeviceEntry {
  const validatedGrants = validGrants(grants, scope)
  const pairedAt = Date.now()
  return {
    ...mintDeviceCredential(),
    name,
    scope,
    pairedAt,
    lastSeenAt: 0,
    // Every new offer can be exchanged for a client-held credential; legacy clients ignore this.
    ticket: true,
    pairingReach,
    ...(validatedGrants ? { grants: validatedGrants } : {}),
    ...(offerTtlMs !== undefined ? { offerExpiresAt: pairedAt + offerTtlMs } : {})
  }
}
