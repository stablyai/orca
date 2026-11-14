import { connect } from 'node:net'
import { browserNetworkExecutionHostKey } from '../../../../shared/browser/client-hosting/browser-network-execution-host'
import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
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
import {
  auditBrowserTunnelDestinationBlocked,
  browserTunnelRemoteTargetBlockReason,
  browserTunnelTargetBlockReason,
  BrowserTunnelDestinationBlockedError,
  createBrowserTunnelGuardedLookup,
  isBrowserTunnelPolicyDisabled
} from '../tunnels/browser-network-tunnel-destination-policy'

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

// Paired clients choose these destinations, so the host refuses metadata and its own Orca listeners.
const guardedNativeDialer: BrowserNetworkTunnelDialer = {
  connect: (target) =>
    connect({
      ...target,
      allowHalfOpen: true,
      lookup: createBrowserTunnelGuardedLookup(target.port, (reason) =>
        auditBrowserTunnelDestinationBlocked(target.host, target.port, reason)
      )
    }),
  openTransport: openConnectedSocket
}

export function connectNativeBrowserNetworkTarget(
  target: BrowserNetworkTunnelOpen,
  env: Record<string, string | undefined> = process.env
): BrowserNetworkTunnelSocket {
  const enforced = !isBrowserTunnelPolicyDisabled(env)
  const reason = enforced ? browserTunnelTargetBlockReason(target.host, target.port) : null
  if (reason) {
    auditBrowserTunnelDestinationBlocked(target.host, target.port, reason)
    throw new BrowserTunnelDestinationBlockedError(reason)
  }
  return connectThroughBrowserNetworkTunnelProxy(
    target,
    selectBrowserNetworkTunnelProxy(target, readNetworkProxySettings(), env),
    enforced ? guardedNativeDialer : nativeDialer
  )
}

/** SSH/WSL routes egress elsewhere; they still must not hand out that machine's metadata. */
export function guardRemoteBrowserNetworkConnect(
  connectTarget: BrowserNetworkExecutionRoute['connect'],
  env: Record<string, string | undefined> = process.env
): BrowserNetworkExecutionRoute['connect'] {
  if (isBrowserTunnelPolicyDisabled(env)) {
    return connectTarget
  }
  return (target) => {
    const reason = browserTunnelRemoteTargetBlockReason(target.host)
    if (reason) {
      auditBrowserTunnelDestinationBlocked(target.host, target.port, reason)
      throw new BrowserTunnelDestinationBlockedError(reason)
    }
    return connectTarget(target)
  }
}
