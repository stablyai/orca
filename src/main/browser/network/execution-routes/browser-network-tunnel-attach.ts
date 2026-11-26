import type { BrowserHostLeaseAuthority } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserNetworkExecutionHost } from '../../../../shared/browser/client-hosting/browser-network-execution-host'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../../../shared/browser/runtime/browser-runtime-capabilities'
import type { PairedRuntimeTunnelAttach } from './paired-runtime-browser-network-transport'

/** A browser page's tunnel: the lease scopes it, so only that lease's runtime may answer. */
export function browserNetworkTunnelAttach(
  lease: BrowserHostLeaseAuthority,
  executionHost: BrowserNetworkExecutionHost
): PairedRuntimeTunnelAttach {
  return {
    method: 'network.browserTunnel',
    params: {
      authorityRuntimeId: lease.authorityRuntimeId,
      authorityEpoch: lease.authorityEpoch,
      browserHostClientId: lease.browserHostClientId,
      browserHostGeneration: lease.browserHostGeneration,
      executionHost
    },
    clientCapabilities: [
      BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
      BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
      ...(executionHost.kind === 'native'
        ? []
        : [BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY])
    ],
    expectedRuntimeId: lease.authorityRuntimeId
  }
}
