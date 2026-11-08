import { describe, expect, it, vi } from 'vitest'
import '../../../../../shared/protocol-version'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../../../../shared/browser-runtime-capabilities'
import { getBrowserHostLeaseRegistry } from '../../../browser-host/leases/browser-host-lease-registry-instance'
import type { BrowserHostLease } from '../../../browser-host/leases/browser-host-lease-records'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from '../../../../browser/network/tunnels/browser-network-tunnel-outbound-memory-budget'
import {
  browserNetworkExecutionHostKey,
  type BrowserNetworkExecutionRoute,
  type BrowserNetworkExecutionRouteResolver
} from '../../../../browser/network/execution-routes/browser-network-execution-route'
import { RpcDispatcher } from '../../dispatcher'
import {
  BROWSER_NETWORK_TUNNEL_METHODS,
  createBrowserNetworkTunnelMethods
} from './browser-network-tunnel'

function request(lease?: BrowserHostLease, overrides: Record<string, unknown> = {}) {
  return {
    id: 'browser-tunnel',
    authToken: 'bound-by-websocket',
    method: 'network.browserTunnel',
    params: {
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: lease?.authorityEpoch ?? 'epoch-without-lease',
      browserHostClientId: lease?.browserHostClientId ?? 'host-a',
      browserHostGeneration: lease?.browserHostGeneration ?? 1,
      executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 1 },
      ...overrides
    }
  }
}

function runtime(cleanups = new Map<string, () => void>()): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'runtime-a',
    getStartedAt: () => 1,
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup)
  } as unknown as OrcaRuntimeService
}

function attachLease(hostRuntime: OrcaRuntimeService): BrowserHostLease {
  return getBrowserHostLeaseRegistry(hostRuntime).attach({
    browserHostClientId: 'host-a',
    connectionId: 'host-control-connection',
    pairedDeviceId: 'device-a',
    hostCapabilities: ['webview']
  }).lease
}

function grantExecutionHost(
  hostRuntime: OrcaRuntimeService,
  lease: BrowserHostLease,
  executionHost: Parameters<typeof browserNetworkExecutionHostKey>[0]
) {
  return getBrowserHostLeaseRegistry(hostRuntime).grantExecutionHost(
    {
      authorityEpoch: lease.authorityEpoch,
      browserHostClientId: lease.browserHostClientId,
      browserHostGeneration: lease.browserHostGeneration,
      pairedDeviceId: lease.pairedDeviceId
    },
    browserNetworkExecutionHostKey(executionHost)
  )
}

const negotiatedCapabilities = [
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
]

describe('network.browserTunnel RPC', () => {
  it('rejects an ungranted SSH route before resolver or binary registration', async () => {
    const hostRuntime = runtime()
    const lease = attachLease(hostRuntime)
    grantExecutionHost(hostRuntime, lease, {
      kind: 'ssh',
      targetId: 'target-b',
      providerEpoch: 'provider-epoch-b',
      connectionGeneration: 1
    })
    const resolveExecutionRoute = vi.fn()
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: createBrowserNetworkTunnelMethods(
        new BrowserNetworkTunnelOutboundMemoryBudgetRegistry(),
        resolveExecutionRoute
      )
    })
    const replies: string[] = []
    const registerBinaryMessageHandler = vi.fn()

    await dispatcher.dispatchStreaming(
      request(lease, {
        executionHost: {
          kind: 'ssh',
          targetId: 'target-a',
          providerEpoch: 'provider-epoch-a',
          connectionGeneration: 2
        }
      }),
      (reply) => replies.push(reply),
      {
        connectionId: 'connection-a',
        clientKind: 'runtime',
        pairedDeviceId: 'device-a',
        clientCapabilities: [
          ...negotiatedCapabilities,
          BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
        ],
        sendBinary: vi.fn(() => true),
        registerBinaryMessageHandler
      }
    )

    expect(JSON.parse(replies[0]!).error.message).toBe('browser_tunnel_execution_host_not_granted')
    expect(resolveExecutionRoute).not.toHaveBeenCalled()
    expect(registerBinaryMessageHandler).not.toHaveBeenCalled()
  })

  it('does not expose execution-route diagnostic detail to the paired caller', async () => {
    const hostRuntime = runtime()
    const lease = attachLease(hostRuntime)
    const executionHost = {
      kind: 'ssh' as const,
      targetId: 'target-a',
      providerEpoch: 'provider-epoch-a',
      connectionGeneration: 2
    }
    grantExecutionHost(hostRuntime, lease, executionHost)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: createBrowserNetworkTunnelMethods(
        new BrowserNetworkTunnelOutboundMemoryBudgetRegistry(),
        vi.fn().mockRejectedValue(new Error('Bad owner or permissions on /Users/alice/.ssh/key'))
      )
    })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      request(lease, { executionHost }),
      (reply) => replies.push(reply),
      {
        connectionId: 'connection-a',
        clientKind: 'runtime',
        pairedDeviceId: 'device-a',
        clientCapabilities: [
          ...negotiatedCapabilities,
          BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
        ],
        sendBinary: vi.fn(() => true),
        registerBinaryMessageHandler: vi.fn()
      }
    )

    expect(JSON.parse(replies[0]!).error.message).toBe('browser_tunnel_execution_host_unavailable')
    expect(replies[0]).not.toContain('/Users/alice')
  })

  it('rejects a grant revoked during connector startup and closes the connector', async () => {
    const hostRuntime = runtime()
    const lease = attachLease(hostRuntime)
    const executionHost = {
      kind: 'ssh' as const,
      targetId: 'target-a',
      providerEpoch: 'provider-epoch-a',
      connectionGeneration: 2
    }
    const grant = grantExecutionHost(hostRuntime, lease, executionHost)
    let resolveExecutionRoute: ((route: BrowserNetworkExecutionRoute) => void) | undefined
    let executionRouteSignal: AbortSignal | undefined
    const close = vi.fn()
    const resolver: BrowserNetworkExecutionRouteResolver = vi.fn((context) => {
      executionRouteSignal = context.signal
      return new Promise<BrowserNetworkExecutionRoute>((resolve) => {
        resolveExecutionRoute = resolve
      })
    })
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: createBrowserNetworkTunnelMethods(
        new BrowserNetworkTunnelOutboundMemoryBudgetRegistry(),
        resolver
      )
    })
    const replies: string[] = []
    const registerBinaryMessageHandler = vi.fn()
    const dispatch = dispatcher.dispatchStreaming(
      request(lease, { executionHost }),
      (reply) => replies.push(reply),
      {
        connectionId: 'connection-a',
        clientKind: 'runtime',
        pairedDeviceId: 'device-a',
        clientCapabilities: [
          ...negotiatedCapabilities,
          BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
        ],
        sendBinary: vi.fn(() => true),
        registerBinaryMessageHandler
      }
    )
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce())

    grant.release()
    expect(executionRouteSignal?.aborted).toBe(true)
    resolveExecutionRoute?.({
      key: browserNetworkExecutionHostKey(executionHost),
      connect: () => {
        throw new Error('unexpected destination open')
      },
      isValid: () => true,
      close
    })
    await dispatch

    expect(JSON.parse(replies[0]!).error.message).toBe('browser_tunnel_execution_host_not_granted')
    expect(registerBinaryMessageHandler).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('fences an older route when the same lease replaces it', async () => {
    const hostRuntime = runtime()
    const lease = attachLease(hostRuntime)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_NETWORK_TUNNEL_METHODS
    })
    const firstReplies: string[] = []
    const secondReplies: string[] = []
    const baseOptions = {
      clientKind: 'runtime' as const,
      pairedDeviceId: 'device-a',
      clientCapabilities: negotiatedCapabilities,
      sendBinary: vi.fn(() => true),
      registerBinaryMessageHandler: vi.fn(() => vi.fn())
    }
    const first = dispatcher.dispatchStreaming(
      request(lease),
      (reply) => firstReplies.push(reply),
      {
        ...baseOptions,
        connectionId: 'connection-a'
      }
    )
    await vi.waitFor(() => expect(firstReplies).toHaveLength(1))
    const second = dispatcher.dispatchStreaming(
      request(lease),
      (reply) => secondReplies.push(reply),
      { ...baseOptions, connectionId: 'connection-b' }
    )

    await first
    await vi.waitFor(() => expect(secondReplies).toHaveLength(1))
    expect(JSON.parse(secondReplies[0]!).result).toEqual({
      type: 'ready',
      tunnelGeneration: 2
    })
    getBrowserHostLeaseRegistry(hostRuntime)
      .attach({
        browserHostClientId: 'host-a',
        connectionId: 'host-control-replacement',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      })
      .release()
    await second
  })
})
