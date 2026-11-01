import type { RpcClient } from '../transport/rpc-client'
import type { MobileBrowserLocalTunnel } from './use-mobile-browser-local-tunnel'

// A served page has no native proxy, so the tunnel code stays out of its bundle.
export function canRenderBrowserLocally(_client: RpcClient | null): boolean {
  return false
}

export function useMobileBrowserLocalTunnel(): MobileBrowserLocalTunnel {
  return { status: 'unavailable' }
}
