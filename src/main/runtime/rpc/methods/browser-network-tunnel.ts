import { BrowserNetworkTunnelSession } from '../../../browser/browser-network-tunnel-session'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from '../../../browser/browser-network-tunnel-outbound-memory-budget'
import {
  browserNetworkExecutionHostKey,
  type BrowserNetworkExecutionRouteResolver
} from '../../../browser/browser-network-execution-route'
import { resolveBrowserNetworkExecutionRoute } from '../../../browser/browser-network-execution-route-dispatch'
import { BrowserNetworkTunnelAttachParams } from '../../../../shared/browser-client-host-protocol'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry-instance'
import { defineStreamingMethod, type RpcAnyMethod } from '../core'

const outboundMemoryBudgets = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()

export function createBrowserNetworkTunnelMethods(
  memoryBudgets: BrowserNetworkTunnelOutboundMemoryBudgetRegistry = outboundMemoryBudgets,
  resolveExecutionRoute: BrowserNetworkExecutionRouteResolver = resolveBrowserNetworkExecutionRoute
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
        if (
          params.executionHost.kind !== 'native' &&
          !clientCapabilities.includes(BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY)
        ) {
          throw new Error('browser_tunnel_execution_hosts_capability_required')
        }
        if (params.authorityRuntimeId !== runtime.getRuntimeId()) {
          throw new Error('browser_tunnel_identity_mismatch')
        }

        const leaseRegistry = getBrowserHostLeaseRegistry(runtime)
        const tunnelIdentity = {
          authorityEpoch: params.authorityEpoch,
          browserHostClientId: params.browserHostClientId,
          browserHostGeneration: params.browserHostGeneration,
          pairedDeviceId,
          executionHostKey: browserNetworkExecutionHostKey(params.executionHost)
        }
        leaseRegistry.requireLease(tunnelIdentity)
        if (params.executionHost.kind !== 'native') {
          leaseRegistry.requireExecutionHost(tunnelIdentity, tunnelIdentity.executionHostKey)
        }
        if (signal?.aborted) {
          return
        }
        const executionRouteAbort = new AbortController()
        const abortExecutionRoute = (): void => executionRouteAbort.abort()
        const unlinkExecutionGrant =
          params.executionHost.kind === 'native'
            ? () => {}
            : leaseRegistry.linkExecutionHostGrant(
                tunnelIdentity,
                tunnelIdentity.executionHostKey,
                abortExecutionRoute
              )
        signal?.addEventListener('abort', abortExecutionRoute, { once: true })
        const outboundMemory = memoryBudgets.acquire(
          `${pairedDeviceId}:${params.browserHostClientId}`
        )
        if (!outboundMemory) {
          unlinkExecutionGrant()
          signal?.removeEventListener('abort', abortExecutionRoute)
          throw new Error('browser_tunnel_memory_admission_failed')
        }
        let executionRoute
        try {
          executionRoute = await resolveExecutionRoute({
            executionHost: params.executionHost,
            runtimeId: runtime.getRuntimeId(),
            runtimeRevision: runtime.getStartedAt(),
            signal: executionRouteAbort.signal
          })
          if (executionRoute.key !== tunnelIdentity.executionHostKey || !executionRoute.isValid()) {
            await executionRoute.close()
            throw new Error('browser_tunnel_execution_host_stale')
          }
          if (signal?.aborted) {
            outboundMemory.release()
            await executionRoute.close()
            return
          }
        } catch (error) {
          outboundMemory.release()
          throw publicExecutionRouteError(error)
        } finally {
          unlinkExecutionGrant()
          signal?.removeEventListener('abort', abortExecutionRoute)
        }
        let route: ReturnType<ReturnType<typeof getBrowserHostLeaseRegistry>['openTunnel']>
        try {
          route = leaseRegistry.openTunnel(tunnelIdentity, {
            requireExecutionHostGrant: params.executionHost.kind !== 'native'
          })
        } catch (error) {
          try {
            outboundMemory.release()
          } finally {
            await executionRoute.close()
          }
          throw error
        }

        let resolveClosed = (): void => {}
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve
        })
        let session: BrowserNetworkTunnelSession | null = null
        let unregisterBinary = (): void => {}
        let executionRouteClose: Promise<void> | null = null
        const closeExecutionRoute = (): Promise<void> => {
          if (!executionRouteClose) {
            try {
              executionRouteClose = Promise.resolve(executionRoute.close())
            } catch (error) {
              executionRouteClose = Promise.reject(error)
            }
            void executionRouteClose.catch(() => {})
          }
          return executionRouteClose
        }
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
              try {
                outboundMemory.release()
              } finally {
                try {
                  route.release()
                } finally {
                  void closeExecutionRoute()
                }
              }
            }
          }
        }
        const subscriptionId = JSON.stringify([
          'browser-network-tunnel',
          connectionId,
          params.browserHostClientId,
          tunnelIdentity.executionHostKey
        ])
        try {
          session = new BrowserNetworkTunnelSession({
            tunnelGeneration: route.tunnelGeneration,
            connect: executionRoute.connect,
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
          void executionRoute.whenInvalidated?.then(() => session?.close())
          unregisterBinary = registerBinaryMessageHandler((bytes) => session?.handleBinary(bytes))
          runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
          signal?.addEventListener('abort', cleanup, { once: true })
          if (signal?.aborted || !executionRoute.isValid()) {
            cleanup()
            return
          }
          emit({ type: 'ready', tunnelGeneration: route.tunnelGeneration })
          await closed
        } finally {
          signal?.removeEventListener('abort', cleanup)
          try {
            cleanup()
          } finally {
            await closeExecutionRoute().catch(() => {})
          }
        }
      }
    })
  ]
}

const PUBLIC_EXECUTION_ROUTE_ERRORS = new Set([
  'browser_tunnel_execution_host_mismatch',
  'browser_tunnel_execution_host_stale',
  'browser_tunnel_execution_host_unavailable'
])

function publicExecutionRouteError(error: unknown): Error {
  if (error instanceof Error && PUBLIC_EXECUTION_ROUTE_ERRORS.has(error.message)) {
    return error
  }
  return new Error('browser_tunnel_execution_host_unavailable', { cause: error })
}

// Why: tests inject this until a live lease and server-owned route generation authorize TCP opens.
export const BROWSER_NETWORK_TUNNEL_METHODS = createBrowserNetworkTunnelMethods()
