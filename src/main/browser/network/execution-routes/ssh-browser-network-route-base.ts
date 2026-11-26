import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { DirectSshAuthority } from '../../../../shared/remote-runtime/ssh/ssh-types'
import type { SshConnection } from '../../../ssh/connection/ssh-connection'
import type { SshConnectionManager } from '../../../ssh/connection/ssh-connection-manager'
import {
  connectThroughBrowserNetworkTunnelProxy,
  type BrowserNetworkTunnelDialer
} from '../tunnels/browser-network-tunnel-proxy-connect'
import type { BrowserNetworkTunnelProxy } from '../tunnels/browser-network-tunnel-proxy-selection'
import type { BrowserNetworkTunnelSocket } from '../tunnels/browser-network-tunnel-stream-state'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'
import type { BrowserNetworkExecutionRoute } from './browser-network-execution-route-contract'

/** What every SSH egress transport shares: the authority it serves and how to invalidate it. */
export type SshBrowserNetworkRouteBase = {
  key: string
  authority: DirectSshAuthority
  connection: SshConnection
  invalidation: AbortController
  releaseInvalidation: () => void
  connectionManager: Pick<SshConnectionManager, 'getConnection'>
  isCurrentAuthority: (authority: DirectSshAuthority) => boolean
  selectProxy: (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelProxy
}

export function isSshBrowserNetworkRouteBaseCurrent(base: SshBrowserNetworkRouteBase): boolean {
  return (
    !base.invalidation.signal.aborted &&
    base.connection.getState().status === 'connected' &&
    base.connectionManager.getConnection(base.authority.targetId) === base.connection &&
    base.isCurrentAuthority(base.authority)
  )
}

/** Wraps one egress transport as a route that dials through the host's proxy and closes its sockets. */
export function finishSshBrowserNetworkRoute(
  base: SshBrowserNetworkRouteBase,
  transport: {
    isValid: () => boolean
    dialer: BrowserNetworkTunnelDialer
    close?: () => void | Promise<void>
    forwardingBlocked?: boolean
  }
): BrowserNetworkExecutionRoute {
  const sockets = new Set<BrowserNetworkTunnelSocket>()
  let closed = false
  const isValid = (): boolean =>
    !closed && isSshBrowserNetworkRouteBaseCurrent(base) && transport.isValid()
  return {
    key: base.key,
    ...(transport.forwardingBlocked ? { forwardingBlocked: true } : {}),
    isValid,
    whenInvalidated: abortPromise(base.invalidation.signal),
    connect: (target) => {
      if (!isValid()) {
        // A bare destroy reaches the session as a pre-connect close; its siblings all fail loudly.
        const socket = new BrowserNetworkDeferredSocket()
        queueMicrotask(() => socket.fail(new Error('browser_tunnel_execution_host_stale')))
        return socket
      }
      // The host's proxy applies, so a host that only reaches the internet that way still browses.
      const socket = connectThroughBrowserNetworkTunnelProxy(
        target,
        base.selectProxy(target),
        transport.dialer
      )
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      return socket
    },
    close: () => {
      if (closed) {
        return
      }
      closed = true
      base.releaseInvalidation()
      base.invalidation.abort()
      for (const socket of sockets) {
        socket.destroy()
      }
      sockets.clear()
      return transport.close?.()
    }
  }
}

function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}
