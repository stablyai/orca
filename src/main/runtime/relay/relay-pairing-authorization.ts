import type { MobilePairingConnectionContext } from '../runtime-rpc'
import type { DeviceCredentialInstallAuthorization } from './relay-control-requests'

export function pairingAuthorizationForContext(
  context: MobilePairingConnectionContext,
  relayHostId: string
): DeviceCredentialInstallAuthorization | null {
  if (context.transport.transport === 'direct') {
    return { mode: 'authenticated-direct', directAuthId: context.connectionId }
  }
  if (context.transport.relayHostId !== relayHostId) {
    throw new Error('stale_relay_connection')
  }
  return context.transport.credentialKind === 'invite'
    ? { mode: 'relay-basis', basisConnId: context.transport.basisConnId }
    : null
}
