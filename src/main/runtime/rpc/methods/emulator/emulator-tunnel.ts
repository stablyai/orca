import { connect } from 'node:net'
import { defineStreamingMethod } from '../../core'
import { EmulatorTunnelParams } from '../../../../../shared/rpc-contract/emulator/emulator-params'
import { BrowserNetworkTunnelSession } from '../../../../browser/network/tunnels/browser-network-tunnel-session'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from '../../../../browser/network/tunnels/browser-network-tunnel-outbound-memory-budget'
import { BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL } from '../../../../browser/network/tunnels/browser-network-tunnel-stream-state'
import { BrowserTunnelDestinationBlockedError } from '../../../../browser/network/tunnels/browser-network-tunnel-destination-policy'
import { BROWSER_NETWORK_TUNNEL_WINDOW_V2_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import { emulatorTunnelTargetAllowed } from '../../../../emulator/emulator-tunnel-target-policy'

const outboundMemoryBudgets = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()
let nextTunnelGeneration = 1

export const EMULATOR_TUNNEL_METHODS = [
  // Reuses the browser tunnel's framing and flow control, admitting only this host's simulator helpers.
  defineStreamingMethod({
    name: 'emulator.tunnel',
    permission: 'workspace',
    params: EmulatorTunnelParams,
    handler: async (
      _params,
      {
        runtime,
        connectionId,
        pairedDeviceId,
        clientKind,
        sendBinary,
        registerBinaryMessageHandler,
        signal
      },
      emit
    ) => {
      if (
        clientKind !== 'runtime' ||
        !connectionId ||
        !pairedDeviceId ||
        !sendBinary ||
        !registerBinaryMessageHandler
      ) {
        throw new Error('authenticated_binary_emulator_tunnel_required')
      }
      if (signal?.aborted) {
        return
      }
      const outboundMemory = outboundMemoryBudgets.acquire(`emulator:${pairedDeviceId}`)
      if (!outboundMemory) {
        throw new Error('emulator_tunnel_memory_admission_failed')
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
            resolveClosed()
          }
        }
      }
      const subscriptionId = JSON.stringify(['emulator-tunnel', connectionId, tunnelGeneration])
      try {
        session = new BrowserNetworkTunnelSession({
          tunnelGeneration,
          connect: (target) => {
            // Checked per open: sessions attached after the tunnel started are reachable too.
            const endpoints = runtime.getEmulatorBridge()?.listSessionEndpointUrls() ?? []
            if (!emulatorTunnelTargetAllowed(target, endpoints)) {
              throw new BrowserTunnelDestinationBlockedError('orca_listener')
            }
            return connect({ host: target.host, port: target.port, allowHalfOpen: true })
          },
          sendBinary: (bytes) => sendBinary(bytes) !== false,
          flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
          claimAggregateRetainedBytes: outboundMemory.claimApplicationBytes,
          onClose: () => {
            try {
              emit({ type: 'closed', tunnelGeneration })
            } finally {
              cleanup()
            }
          }
        })
        unregisterBinary = registerBinaryMessageHandler((bytes) => session?.handleBinary(bytes))
        runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
        signal?.addEventListener('abort', cleanup, { once: true })
        if (signal?.aborted) {
          cleanup()
          return
        }
        emit({
          type: 'ready',
          tunnelGeneration,
          capabilities: [BROWSER_NETWORK_TUNNEL_WINDOW_V2_CAPABILITY]
        })
        await closed
      } finally {
        signal?.removeEventListener('abort', cleanup)
        cleanup()
      }
    }
  })
]
