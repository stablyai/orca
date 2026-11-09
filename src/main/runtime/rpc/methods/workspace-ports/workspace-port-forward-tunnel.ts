import { connect as netConnect } from 'node:net'
import { BrowserNetworkTunnelSession } from '../../../../browser/network/tunnels/browser-network-tunnel-session'
import {
  BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
  type BrowserNetworkTunnelSocket
} from '../../../../browser/network/tunnels/browser-network-tunnel-stream-state'
import {
  BrowserTunnelDestinationBlockedError,
  browserTunnelTargetBlockReason,
  isBrowserTunnelPolicyDisabled
} from '../../../../browser/network/tunnels/browser-network-tunnel-destination-policy'
import type { BrowserNetworkTunnelOpen } from '../../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import { WORKSPACE_PORTS_FORWARD_TUNNEL_RUNTIME_CAPABILITY } from '../../../../../shared/workspace-ports-runtime-capabilities'
import { WorkspacePortForwardTunnelParams } from '../../../../../shared/rpc-contract/workspace-ports-params'
import { defineStreamingMethod } from '../../core'

// Each subscription is its own session, so a fixed generation is enough to validate frames.
const TUNNEL_GENERATION = 1

const LOOPBACK_TARGET_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export class PortForwardDestinationRefusedError extends Error {
  constructor() {
    super('port_forward_destination_refused')
  }
}

type Dial = (target: { host: string; port: number }) => BrowserNetworkTunnelSocket

const dialLoopback: Dial = ({ host, port }) =>
  // Why `localhost` + autoSelectFamily: dev servers bind 127.0.0.1 or only ::1 depending on the toolchain.
  netConnect({
    host: host === '::1' ? '::1' : 'localhost',
    port,
    autoSelectFamily: true,
    allowHalfOpen: true
  })

/**
 * Dials only this host's loopback, never LAN or other machines: a port forward exposes a dev server the
 * client saw in a port scan. Orca's own listeners and metadata stay refused by the shared tunnel policy.
 */
export function createPortForwardDialer(
  env: Record<string, string | undefined> = process.env,
  dial: Dial = dialLoopback
): (target: BrowserNetworkTunnelOpen) => BrowserNetworkTunnelSocket {
  return (target) => {
    const host = target.host.toLowerCase()
    if (
      !LOOPBACK_TARGET_HOSTS.has(host) ||
      !Number.isInteger(target.port) ||
      target.port < 1 ||
      target.port > 65_535
    ) {
      throw new PortForwardDestinationRefusedError()
    }
    if (!isBrowserTunnelPolicyDisabled(env)) {
      const reason = browserTunnelTargetBlockReason(host, target.port)
      if (reason) {
        throw new BrowserTunnelDestinationBlockedError(reason)
      }
    }
    return dial({ host, port: target.port })
  }
}

/** Carries a paired client's local listener to a port on this host's loopback (its Ports panel forwards). */
export function createWorkspacePortForwardTunnelMethod(
  connect: (
    target: BrowserNetworkTunnelOpen
  ) => BrowserNetworkTunnelSocket = createPortForwardDialer()
) {
  return defineStreamingMethod({
    name: 'workspacePorts.forwardTunnel',
    // Why host-admin: like the browser tunnel, this reaches arbitrary host loopback ports.
    permission: 'host-admin',
    params: WorkspacePortForwardTunnelParams,
    handler: async (_params, ctx, emit) => {
      const {
        runtime,
        connectionId,
        pairedDeviceId,
        clientKind,
        clientCapabilities,
        sendBinary,
        registerBinaryMessageHandler,
        signal
      } = ctx
      if (
        clientKind !== 'runtime' ||
        !connectionId ||
        !pairedDeviceId ||
        !sendBinary ||
        !registerBinaryMessageHandler
      ) {
        throw new Error('authenticated_binary_port_forward_required')
      }
      if (!clientCapabilities?.includes(WORKSPACE_PORTS_FORWARD_TUNNEL_RUNTIME_CAPABILITY)) {
        throw new Error('port_forward_capability_required')
      }
      if (signal?.aborted) {
        return
      }
      const closed = Promise.withResolvers<void>()
      let session: BrowserNetworkTunnelSession | null = null
      let unregisterBinary = (): void => {}
      let cleaned = false
      const close = (): void => session?.close()
      // A transport subscription owns its own socket, so the connection names this tunnel.
      const subscriptionId = JSON.stringify(['workspace-port-forward-tunnel', connectionId])
      const cleanup = (): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        signal?.removeEventListener('abort', close)
        unregisterBinary()
        close()
        closed.resolve()
      }
      session = new BrowserNetworkTunnelSession({
        tunnelGeneration: TUNNEL_GENERATION,
        connect,
        sendBinary: (bytes) => sendBinary(bytes) !== false,
        flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
        onClose: () => {
          try {
            emit({ type: 'closed', tunnelGeneration: TUNNEL_GENERATION })
          } finally {
            cleanup()
          }
        }
      })
      unregisterBinary = registerBinaryMessageHandler((bytes) => session?.handleBinary(bytes))
      runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
      signal?.addEventListener('abort', close, { once: true })
      if (signal?.aborted) {
        close()
      } else {
        emit({ type: 'ready', tunnelGeneration: TUNNEL_GENERATION })
      }
      try {
        await closed.promise
      } finally {
        cleanup()
      }
    }
  })
}
