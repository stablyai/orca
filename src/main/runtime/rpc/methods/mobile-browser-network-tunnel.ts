import { isFetchBadPort } from '../../../browser/browser-network-bad-ports'
import {
  parseBrowserNetworkExecutionHostKey,
  type BrowserNetworkExecutionRoute,
  type BrowserNetworkExecutionRouteResolver
} from '../../../browser/browser-network-execution-route'
import { resolveBrowserNetworkExecutionRoute } from '../../../browser/browser-network-execution-route-dispatch'
import type { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from '../../../browser/browser-network-tunnel-outbound-memory-budget'
import { BrowserNetworkTunnelSession } from '../../../browser/browser-network-tunnel-session'
import { randomUUID } from 'node:crypto'
import {
  MOBILE_BROWSER_TUNNEL_METHOD,
  MOBILE_BROWSER_TUNNEL_UNSUBSCRIBE_METHOD,
  MobileBrowserTunnelParams,
  MobileBrowserTunnelUnsubscribeParams
} from '../../../../shared/mobile-browser-tunnel-protocol'
import { defineMethod, defineStreamingMethod } from '../core'
import { BROWSER_NETWORK_TUNNEL_OUTBOUND_MEMORY } from './browser-network-tunnel'

const MAX_TUNNEL_GENERATION = 0xffff_ffff
let lastTunnelGeneration = 0

function nextTunnelGeneration(): number {
  lastTunnelGeneration =
    lastTunnelGeneration >= MAX_TUNNEL_GENERATION ? 1 : lastTunnelGeneration + 1
  return lastTunnelGeneration
}

/** A phone's own web view reaches the workspace's network through this tunnel, so pages see this host's address and sign-ins.
 *  Workspace permission already runs host-user commands, so the tunnel grants nothing a terminal could not; it keeps browser port rules. */
export function createMobileBrowserTunnelMethods(
  memoryBudgets: BrowserNetworkTunnelOutboundMemoryBudgetRegistry = BROWSER_NETWORK_TUNNEL_OUTBOUND_MEMORY,
  resolveExecutionRoute: BrowserNetworkExecutionRouteResolver = resolveBrowserNetworkExecutionRoute
) {
  return [
    defineStreamingMethod({
      name: MOBILE_BROWSER_TUNNEL_METHOD,
      permission: 'workspace',
      params: MobileBrowserTunnelParams,
      handler: async (
        params,
        {
          runtime,
          connectionId,
          pairedDeviceId,
          clientKind,
          sendBinary,
          registerBrowserTunnelFrameHandler,
          signal
        },
        emit
      ) => {
        if (
          clientKind !== 'mobile' ||
          !connectionId ||
          !pairedDeviceId ||
          !sendBinary ||
          !registerBrowserTunnelFrameHandler
        ) {
          throw new Error('authenticated_phone_browser_tunnel_required')
        }
        const resolution = await runtime.resolveBrowserExecutionHostKeyForWorkspace(
          params.workspaceId
        )
        if (resolution.status !== 'resolved') {
          throw new Error('browser_tunnel_execution_host_unavailable')
        }
        if (signal?.aborted) {
          return
        }
        const outboundMemory = memoryBudgets.acquire(`mobile:${pairedDeviceId}`)
        if (!outboundMemory) {
          throw new Error('browser_tunnel_memory_admission_failed')
        }
        let route: BrowserNetworkExecutionRoute
        try {
          route = await resolveExecutionRoute({
            executionHost: parseBrowserNetworkExecutionHostKey(resolution.executionHostKey),
            runtimeId: runtime.getRuntimeId(),
            runtimeRevision: runtime.getStartedAt(),
            ...(signal ? { signal } : {})
          })
        } catch (error) {
          outboundMemory.release()
          throw new Error('browser_tunnel_execution_host_unavailable', { cause: error })
        }

        const tunnelGeneration = nextTunnelGeneration()
        // Unguessable, because the unsubscribe method trusts whoever names it.
        const subscriptionId = `mobile-browser-tunnel:${randomUUID()}`
        let resolveClosed = (): void => {}
        const closed = new Promise<void>((resolve) => {
          resolveClosed = resolve
        })
        const session = new BrowserNetworkTunnelSession({
          tunnelGeneration,
          connect: (target) => {
            if (isFetchBadPort(target.port)) {
              throw new Error('browser_tunnel_port_blocked')
            }
            return route.connect(target)
          },
          sendBinary: (bytes) => sendBinary(bytes) !== false,
          claimAggregateRetainedBytes: outboundMemory.claimApplicationBytes,
          onClose: () => {
            try {
              emit({ type: 'closed', tunnelGeneration })
            } finally {
              resolveClosed()
            }
          }
        })
        let unregisterFrames = (): void => {}
        let cleaned = false
        const cleanup = (): void => {
          if (cleaned) {
            return
          }
          cleaned = true
          try {
            unregisterFrames()
            session.close()
          } finally {
            outboundMemory.release()
            resolveClosed()
            void Promise.resolve(route.close()).catch(() => {})
          }
        }
        try {
          unregisterFrames = registerBrowserTunnelFrameHandler((bytes) =>
            session.handleBinary(bytes)
          )
          runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
          signal?.addEventListener('abort', cleanup, { once: true })
          void route.whenInvalidated?.then(cleanup)
          if (signal?.aborted || !route.isValid()) {
            return
          }
          emit({ type: 'ready', tunnelGeneration, subscriptionId })
          await closed
        } finally {
          signal?.removeEventListener('abort', cleanup)
          cleanup()
        }
      }
    }),
    defineMethod({
      name: MOBILE_BROWSER_TUNNEL_UNSUBSCRIBE_METHOD,
      permission: 'workspace',
      params: MobileBrowserTunnelUnsubscribeParams,
      handler: (params, { runtime }) => {
        runtime.cleanupSubscription(params.subscriptionId)
        return { unsubscribed: true }
      }
    })
  ]
}

export const MOBILE_BROWSER_TUNNEL_METHODS = createMobileBrowserTunnelMethods()
