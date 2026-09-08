import type { HostProfile } from '../transport/types'
import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import { createNativeDiagnosticsOperations } from '../diagnostics/native-diagnostics-operations'
import { createMobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'

export function createSettingsAuthority(
  host: HostProfile,
  buildId: string,
  context: RpcClientContextValue
) {
  return {
    ...createMobileWebNativeCapabilityAuthority({
      hostIdentity: host.publicKeyB64,
      buildIdentity: buildId
    }),
    diagnosticsDevice: createNativeDiagnosticsOperations(host, context)
  }
}
