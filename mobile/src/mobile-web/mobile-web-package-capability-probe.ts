import {
  MOBILE_WEB_PACKAGE_GZIP_RUNTIME_CAPABILITY,
  MOBILE_WEB_PACKAGE_RANGE_RUNTIME_CAPABILITY,
  MOBILE_WEB_HYBRID_BASELINE_RUNTIME_CAPABILITY,
  MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import type { ResolvedMobileWebPackageCapability } from './mobile-web-package-session-state'

/** The answer is only ever valid for the client and connection that asked, so it carries both. */
export function startMobileWebPackageCapabilityProbe(
  client: RpcClient,
  hostId: string,
  connectionId: number | null,
  onResolved: (capability: ResolvedMobileWebPackageCapability) => void
): () => void {
  return startRuntimeCapabilityProbe(client, (capabilities) => {
    onResolved({
      client,
      hostId,
      connectionId,
      supported:
        capabilities.includes(MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY) &&
        capabilities.includes(MOBILE_WEB_HYBRID_BASELINE_RUNTIME_CAPABILITY),
      gzip: capabilities.includes(MOBILE_WEB_PACKAGE_GZIP_RUNTIME_CAPABILITY),
      range: capabilities.includes(MOBILE_WEB_PACKAGE_RANGE_RUNTIME_CAPABILITY)
    })
  })
}
