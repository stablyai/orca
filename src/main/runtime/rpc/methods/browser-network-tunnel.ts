import { connect } from 'node:net'
import { z } from 'zod'
import { BrowserNetworkTunnelSession } from '../../../browser/browser-network-tunnel-session'
import { BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { defineStreamingMethod, type RpcAnyMethod } from '../core'

const BrowserNetworkTunnelAttach = z.object({
  authorityRuntimeId: z.string().min(1),
  browserHostClientId: z.string().min(1),
  executionHost: z.object({ kind: z.literal('native') }),
  tunnelGeneration: z.number().int().min(1).max(0xffff_ffff)
})

// Why: tests inject this until a live lease and server-owned route generation authorize TCP opens.
export const BROWSER_NETWORK_TUNNEL_METHODS: RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'network.browserTunnel',
    params: BrowserNetworkTunnelAttach,
    handler: async (
      params,
      {
        runtime,
        connectionId,
        pairedDeviceId,
        clientKind,
        clientCapabilities,
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
        throw new Error('authenticated_binary_browser_tunnel_required')
      }
      if (!clientCapabilities?.includes(BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY)) {
        throw new Error('browser_tunnel_capability_required')
      }
      if (
        params.authorityRuntimeId !== runtime.getRuntimeId() ||
        params.browserHostClientId !== pairedDeviceId
      ) {
        throw new Error('browser_tunnel_identity_mismatch')
      }

      let resolveClosed = (): void => {}
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve
      })
      const session = new BrowserNetworkTunnelSession({
        tunnelGeneration: params.tunnelGeneration,
        connect: (target) => connect({ ...target, allowHalfOpen: true }),
        sendBinary: (bytes) => sendBinary(bytes) !== false,
        onClose: () => {
          emit({ type: 'closed', tunnelGeneration: params.tunnelGeneration })
          resolveClosed()
        }
      })
      const unregisterBinary = registerBinaryMessageHandler((bytes) => session.handleBinary(bytes))
      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        unregisterBinary()
        session.close()
      }
      const subscriptionId = `browser-network-tunnel:${connectionId}`
      try {
        runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
        signal?.addEventListener('abort', cleanup, { once: true })
        emit({ type: 'ready', tunnelGeneration: params.tunnelGeneration })
        await closed
      } finally {
        signal?.removeEventListener('abort', cleanup)
        cleanup()
      }
    }
  })
]
