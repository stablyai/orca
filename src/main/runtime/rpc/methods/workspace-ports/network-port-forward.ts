import { BrowserNetworkTunnelSession } from '../../../../browser/network/tunnels/browser-network-tunnel-session'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from '../../../../browser/network/tunnels/browser-network-tunnel-outbound-memory-budget'
import {
  BROWSER_NETWORK_TUNNEL_LEGACY_FLOW_CONTROL,
  BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
  type BrowserNetworkTunnelSessionOptions
} from '../../../../browser/network/tunnels/browser-network-tunnel-stream-state'
import { connectNativeBrowserNetworkTarget } from '../../../../browser/network/execution-routes/browser-network-execution-route'
import { BrowserTunnelDestinationBlockedError } from '../../../../browser/network/tunnels/browser-network-tunnel-destination-policy'
import { BROWSER_NETWORK_TUNNEL_WINDOW_V2_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import { NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/workspace-ports-runtime-capabilities'
import {
  NetworkPortForwardAttachParams,
  pairedPortForwardDialHost
} from '../../../../../shared/workspace/ports/port-forward-loopback-host'
import { defineStreamingMethod } from '../../core'

type ConnectTarget = BrowserNetworkTunnelSessionOptions['connect']

const outboundMemoryBudgets = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()
let nextTunnelGeneration = 1

/** Dials only this host's own loopback; the native dial still refuses Orca's own listeners. */
export function connectPairedPortForwardTarget(
  target: Parameters<ConnectTarget>[0],
  connect: ConnectTarget = connectNativeBrowserNetworkTarget
): ReturnType<ConnectTarget> {
  const host = pairedPortForwardDialHost(target.host)
  if (!host) {
    throw new BrowserTunnelDestinationBlockedError('not_loopback')
  }
  return connect({ host, port: target.port })
}

// A paired desktop forwards this host's localhost ports to its own loopback, one stream per connection.
export function createNetworkPortForwardMethods(
  memoryBudgets: BrowserNetworkTunnelOutboundMemoryBudgetRegistry = outboundMemoryBudgets,
  connectTarget: ConnectTarget = connectPairedPortForwardTarget
) {
  return [
    defineStreamingMethod({
      name: 'network.portForward',
      permission: 'host-admin',
      params: NetworkPortForwardAttachParams,
      handler: async (
        _params,
        {
          connectionId,
          pairedDeviceId,
          clientKind,
          clientCapabilities,
          sendBinary,
          registerBinaryMessageHandler,
          runtime,
          signal
        },
        emit
      ) => {
        // Phones and local CLI callers never forward; only a paired desktop on its authenticated socket.
        if (
          clientKind !== 'runtime' ||
          !connectionId ||
          !pairedDeviceId ||
          !sendBinary ||
          !registerBinaryMessageHandler
        ) {
          throw new Error('authenticated_binary_port_forward_required')
        }
        if (!clientCapabilities?.includes(NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY)) {
          throw new Error('port_forward_capability_required')
        }
        if (signal?.aborted) {
          return
        }
        const outboundMemory = memoryBudgets.acquire(`${pairedDeviceId}:port-forward`)
        if (!outboundMemory) {
          throw new Error('port_forward_memory_admission_failed')
        }
        const tunnelGeneration = nextTunnelGeneration++
        let resolveClosed = (): void => {}
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve
        })
        let session: BrowserNetworkTunnelSession | null = null
        let unregisterBinary = (): void => {}
        let cleaned = false
        const cleanup = (): void => {
          if (cleaned) {
            return
          }
          cleaned = true
          try {
            unregisterBinary()
          } finally {
            try {
              const activeSession = session
              session = null
              activeSession?.close()
            } finally {
              outboundMemory.release()
            }
          }
        }
        const windowV2 = clientCapabilities.includes(BROWSER_NETWORK_TUNNEL_WINDOW_V2_CAPABILITY)
        try {
          session = new BrowserNetworkTunnelSession({
            tunnelGeneration,
            connect: connectTarget,
            sendBinary: (bytes) => sendBinary(bytes) !== false,
            flowControl: windowV2
              ? BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL
              : BROWSER_NETWORK_TUNNEL_LEGACY_FLOW_CONTROL,
            claimAggregateRetainedBytes: outboundMemory.claimApplicationBytes,
            onClose: () => {
              try {
                emit({ type: 'closed', tunnelGeneration })
              } finally {
                resolveClosed()
              }
            }
          })
          unregisterBinary = registerBinaryMessageHandler((bytes) => session?.handleBinary(bytes))
          runtime.registerSubscriptionCleanup(
            JSON.stringify(['network-port-forward', connectionId, tunnelGeneration]),
            cleanup,
            connectionId
          )
          signal?.addEventListener('abort', cleanup, { once: true })
          if (signal?.aborted) {
            cleanup()
            return
          }
          emit({
            type: 'ready',
            tunnelGeneration,
            ...(windowV2 ? { capabilities: [BROWSER_NETWORK_TUNNEL_WINDOW_V2_CAPABILITY] } : {})
          })
          await closed
        } finally {
          signal?.removeEventListener('abort', cleanup)
          cleanup()
        }
      }
    })
  ]
}

export const NETWORK_PORT_FORWARD_METHODS = createNetworkPortForwardMethods()
