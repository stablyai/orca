import { connect } from 'node:net'
import { browserNetworkExecutionHostKey } from '../../../../shared/browser/client-hosting/browser-network-execution-host'
import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from '../tunnels/browser-network-tunnel-stream-state'
import { readNetworkProxySettings } from './browser-network-proxy-settings-source'
import { selectBrowserNetworkTunnelProxy } from '../tunnels/browser-network-tunnel-proxy-selection'
import {
  connectThroughBrowserNetworkTunnelProxy,
  type BrowserNetworkTunnelDialer
} from '../tunnels/browser-network-tunnel-proxy-connect'
import type {
  BrowserNetworkExecutionRoute,
  BrowserNetworkExecutionRouteContext
} from './browser-network-execution-route-contract'
import { openConnectedSocket } from '../tunnels/browser-network-connected-socket'

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

const nativeDialer: BrowserNetworkTunnelDialer = {
  connect: (target) => connect({ ...target, allowHalfOpen: true }),
  openTransport: openConnectedSocket
}

export function connectNativeBrowserNetworkTarget(
  target: BrowserNetworkTunnelOpen,
  env: Record<string, string | undefined> = process.env
): BrowserNetworkTunnelSocket {
  return connectThroughBrowserNetworkTunnelProxy(
    target,
    selectBrowserNetworkTunnelProxy(target, readNetworkProxySettings(), env),
    nativeDialer
  )
}
