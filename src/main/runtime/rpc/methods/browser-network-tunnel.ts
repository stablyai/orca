import { connect } from 'node:net'
import { BrowserNetworkTunnelSession } from '../../../browser/browser-network-tunnel-session'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from '../../../browser/browser-network-tunnel-outbound-memory-budget'
import { BrowserNetworkTunnelAttachParams } from '../../../../shared/browser-client-host-protocol'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry'
import { defineStreamingMethod, type RpcAnyMethod } from '../core'

const outboundMemoryBudgets = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()

export function createBrowserNetworkTunnelMethods(
  memoryBudgets: BrowserNetworkTunnelOutboundMemoryBudgetRegistry = outboundMemoryBudgets
): RpcAnyMethod[] {
  return [
    defineStreamingMethod({
      name: 'network.browserTunnel',
      params: BrowserNetworkTunnelAttachParams,
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
        if (!clientCapabilities.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY)) {
          throw new Error('browser_client_host_capability_required')
        }
        if (params.authorityRuntimeId !== runtime.getRuntimeId()) {
          throw new Error('browser_tunnel_identity_mismatch')
        }
        if (
          params.executionHost.runtimeId !== runtime.getRuntimeId() ||
          params.executionHost.revision !== runtime.getStartedAt()
        ) {
          throw new Error('browser_tunnel_execution_host_mismatch')
        }

        const leaseRegistry = getBrowserHostLeaseRegistry(runtime)
        const tunnelIdentity = {
          authorityEpoch: params.authorityEpoch,
          browserHostClientId: params.browserHostClientId,
          browserHostGeneration: params.browserHostGeneration,
          pairedDeviceId,
          executionHostKey: `native:${params.executionHost.runtimeId}:${params.executionHost.revision}`
        }
        leaseRegistry.requireLease(tunnelIdentity)
        const outboundMemory = memoryBudgets.acquire(
          `${pairedDeviceId}:${params.browserHostClientId}`
        )
        if (!outboundMemory) {
          throw new Error('browser_tunnel_memory_admission_failed')
        }
        let route: ReturnType<ReturnType<typeof getBrowserHostLeaseRegistry>['openTunnel']>
        try {
          route = leaseRegistry.openTunnel(tunnelIdentity)
        } catch (error) {
          outboundMemory.release()
          throw error
        }

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
              session?.close()
            } finally {
              outboundMemory.release()
              route.release()
            }
          }
        }
        const subscriptionId = `browser-network-tunnel:${connectionId}`
        try {
          session = new BrowserNetworkTunnelSession({
            tunnelGeneration: route.tunnelGeneration,
            connect: (target) => connect({ ...target, allowHalfOpen: true }),
            sendBinary: (bytes) => sendBinary(bytes) !== false,
            claimAggregateRetainedBytes: outboundMemory.claimApplicationBytes,
            onClose: () => {
              try {
                emit({ type: 'closed', tunnelGeneration: route.tunnelGeneration })
              } finally {
                resolveClosed()
              }
            }
          })
          void route.whenFenced.then(() => session?.close())
          unregisterBinary = registerBinaryMessageHandler((bytes) => session?.handleBinary(bytes))
          runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
          signal?.addEventListener('abort', cleanup, { once: true })
          if (signal?.aborted) {
            cleanup()
            return
          }
          emit({ type: 'ready', tunnelGeneration: route.tunnelGeneration })
          await closed
        } finally {
          signal?.removeEventListener('abort', cleanup)
          cleanup()
        }
      }
    })
  ]
}

// Why: tests inject this until a live lease and server-owned route generation authorize TCP opens.
export const BROWSER_NETWORK_TUNNEL_METHODS = createBrowserNetworkTunnelMethods()
