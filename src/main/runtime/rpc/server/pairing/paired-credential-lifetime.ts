import type { RpcContext } from '../../core'
import type { DeviceRegistry } from './device-registry'
import type { DevicePrincipal } from './device-principal'

export function pairedCredentialLifetime(
  registry: DeviceRegistry,
  principal: DevicePrincipal,
  deviceToken: string | null
): NonNullable<RpcContext['authenticatedCredential']> {
  const binding = {
    deviceId: principal.deviceId,
    credentialRevision: principal.credentialRevision,
    ...(deviceToken ? { deviceToken } : {})
  }
  return {
    revision: principal.credentialRevision,
    isCurrent: () => Boolean(registry.resolveAuthenticatedPrincipal(binding))
  }
}
