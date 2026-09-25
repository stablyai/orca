import type { SubscribeBrowserHostLease } from '../../shared/browser-client-host/browser-host-lease-subscription'
import type { PairingOffer } from '../../shared/pairing'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscriptionOptions
} from '../../shared/remote-runtime-client'

export function createDesktopBrowserHostLeaseSubscription(
  pairing: PairingOffer,
  options?: RemoteRuntimeSubscriptionOptions
): SubscribeBrowserHostLease {
  return (params, timeoutMs, callbacks) =>
    subscribeRemoteRuntimeRequest(
      pairing,
      'browser.clientHost.attach',
      params,
      timeoutMs,
      callbacks,
      {
        ...options,
        // Metadata is authorized on the same connection that attached the lease.
        clientCapabilities: [
          ...(options?.clientCapabilities ?? []),
          BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
          BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
        ]
      }
    )
}
