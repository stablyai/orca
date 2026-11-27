import type { LookupAddress, LookupOptions } from 'node:dns'
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

const LOOPBACK_ANSWERS: readonly LookupAddress[] = [
  { address: '127.0.0.1', family: 4 },
  { address: '::1', family: 6 }
]

// `localhost` answers only with loopback here, whatever the host's resolver or hosts file says.
function loopbackOnlyLookup(
  _hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number
  ) => void
): void {
  const answers = LOOPBACK_ANSWERS.filter(
    (answer) => !options.family || answer.family === options.family
  )
  if (options.all) {
    callback(null, answers)
    return
  }
  callback(null, answers[0]!.address, answers[0]!.family)
}

/** Dials this host's own loopback directly: a proxy would carry it to another machine's localhost.
 *  Orca's own listeners stay refused unless the host opts out of the destination policy. */
export function connectNativeLoopbackTarget(
  target: BrowserNetworkTunnelOpen,
  env: Record<string, string | undefined> = process.env
): BrowserNetworkTunnelSocket {
  const reason = isBrowserTunnelPolicyDisabled(env)
    ? null
    : browserTunnelTargetBlockReason(target.host, target.port)
  if (reason) {
    auditBrowserTunnelDestinationBlocked(target.host, target.port, reason)
    throw new BrowserTunnelDestinationBlockedError(reason)
  }
  return connect({ ...target, allowHalfOpen: true, lookup: loopbackOnlyLookup })
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
