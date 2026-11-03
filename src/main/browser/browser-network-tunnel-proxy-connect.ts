import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelProxy } from './browser-network-tunnel-proxy-selection'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'
import { HttpConnectTunnelSocket } from './http-connect-tunnel-socket'
import type { ProxyHandshakeTransport } from './proxy-handshake-socket'
import { SystemSshSocksClientSocket } from './system-ssh-socks-client-socket'

/** How an execution host opens TCP connections of its own. */
export type BrowserNetworkTunnelDialer = {
  connect: (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelSocket
  /** Resolves once a stream to the proxy itself is connected; the signal abandons the attempt. */
  openTransport: (
    endpoint: BrowserNetworkTunnelOpen,
    signal: AbortSignal
  ) => Promise<ProxyHandshakeTransport>
}

/** Dials a tunnel destination from an execution host through the proxy selected for it there. */
export function connectThroughBrowserNetworkTunnelProxy(
  target: BrowserNetworkTunnelOpen,
  proxy: BrowserNetworkTunnelProxy,
  dialer: BrowserNetworkTunnelDialer
): BrowserNetworkTunnelSocket {
  if (proxy.kind === 'direct') {
    return dialer.connect(target)
  }
  if (proxy.kind === 'http') {
    const endpoint = proxyEndpoint(proxy.url, proxy.url.protocol === 'https:' ? 443 : 80)
    return new HttpConnectTunnelSocket(proxy.url, target, (signal) =>
      dialer.openTransport(endpoint, signal)
    )
  }
  if (proxy.kind === 'socks5' && !proxy.url.username && !proxy.url.password) {
    const endpoint = proxyEndpoint(proxy.url, 1080)
    return new SystemSshSocksClientSocket(target, (signal) =>
      dialer.openTransport(endpoint, signal)
    )
  }
  // Reject unsupported proxies to prevent direct traffic from bypassing host policy.
  throw new Error('browser_tunnel_proxy_unsupported')
}

function proxyEndpoint(url: URL, defaultPort: number): BrowserNetworkTunnelOpen {
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || defaultPort }
}
