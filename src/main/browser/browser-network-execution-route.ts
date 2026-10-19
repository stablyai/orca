import { connect } from 'node:net'
import { BrowserNetworkExecutionHost } from '../../shared/browser-network-execution-host'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'
import { readNetworkProxySettings } from './browser-network-proxy-settings-source'
import { selectBrowserNetworkTunnelProxy } from './browser-network-tunnel-proxy-selection'
import { HttpConnectTunnelSocket } from './http-connect-tunnel-socket'
import { SystemSshSocksClientSocket } from './system-ssh-socks-client-socket'

export type BrowserNetworkExecutionRoute = {
  key: string
  connect: (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelSocket
  whenInvalidated?: Promise<void>
  isValid: () => boolean
  close: () => void | Promise<void>
}

export type BrowserNetworkExecutionRouteContext = {
  executionHost: BrowserNetworkExecutionHost
  runtimeId: string
  runtimeRevision: number
  signal?: AbortSignal
}

export type BrowserNetworkExecutionRouteResolver = (
  context: BrowserNetworkExecutionRouteContext
) => Promise<BrowserNetworkExecutionRoute>

export function browserNetworkExecutionHostKey(host: BrowserNetworkExecutionHost): string {
  if (host.kind === 'native') {
    return JSON.stringify(['native', host.runtimeId, host.revision])
  }
  if (host.kind === 'wsl') {
    return JSON.stringify(['wsl', host.runtimeId, host.revision, host.distro])
  }
  return JSON.stringify(['ssh', host.targetId, host.providerEpoch, host.connectionGeneration])
}

export function parseBrowserNetworkExecutionHostKey(key: string): BrowserNetworkExecutionHost {
  let tuple: unknown
  try {
    tuple = JSON.parse(key)
  } catch {
    throw new Error('browser_tunnel_execution_host_key_invalid')
  }
  const candidate =
    Array.isArray(tuple) && tuple[0] === 'native' && tuple.length === 3
      ? { kind: 'native', runtimeId: tuple[1], revision: tuple[2] }
      : Array.isArray(tuple) && tuple[0] === 'wsl' && tuple.length === 4
        ? { kind: 'wsl', runtimeId: tuple[1], revision: tuple[2], distro: tuple[3] }
        : Array.isArray(tuple) && tuple[0] === 'ssh' && tuple.length === 4
          ? {
              kind: 'ssh',
              targetId: tuple[1],
              providerEpoch: tuple[2],
              connectionGeneration: tuple[3]
            }
          : null
  const parsed = BrowserNetworkExecutionHost.safeParse(candidate)
  if (!parsed.success || browserNetworkExecutionHostKey(parsed.data) !== key) {
    throw new Error('browser_tunnel_execution_host_key_invalid')
  }
  return parsed.data
}

export function resolveNativeBrowserNetworkExecutionRoute(
  context: BrowserNetworkExecutionRouteContext
): BrowserNetworkExecutionRoute {
  const host = context.executionHost
  if (
    host.kind !== 'native' ||
    host.runtimeId !== context.runtimeId ||
    host.revision !== context.runtimeRevision
  ) {
    throw new Error('browser_tunnel_execution_host_mismatch')
  }
  return {
    key: browserNetworkExecutionHostKey(host),
    connect: connectNativeBrowserNetworkTarget,
    isValid: () => true,
    close: () => {}
  }
}

/** Dials a tunnel destination from this host the way its own browser would: through its proxy. */
export function connectNativeBrowserNetworkTarget(
  target: BrowserNetworkTunnelOpen,
  env: Record<string, string | undefined> = process.env
): BrowserNetworkTunnelSocket {
  const proxy = selectBrowserNetworkTunnelProxy(target, readNetworkProxySettings(), env)
  if (proxy.kind === 'http') {
    return new HttpConnectTunnelSocket(proxy.url, target)
  }
  if (proxy.kind === 'socks5' && !proxy.url.username && !proxy.url.password) {
    return new SystemSshSocksClientSocket(
      { host: proxy.url.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.url.port) || 1080 },
      target
    )
  }
  if (proxy.kind !== 'direct') {
    // Why throw, not dial direct: a host that requires a proxy must not leak traffic around it.
    throw new Error('browser_tunnel_proxy_unsupported')
  }
  return connect({ ...target, allowHalfOpen: true })
}
