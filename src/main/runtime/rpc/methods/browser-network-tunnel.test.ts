import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { getBrowserHostLeaseRegistry } from '../../browser-host-lease-registry-instance'
import type { BrowserHostLease } from '../../browser-host-lease-records'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from '../../../browser/browser-network-tunnel-outbound-memory-budget'
import {
  browserNetworkExecutionHostKey,
  type BrowserNetworkExecutionRoute,
  type BrowserNetworkExecutionRouteResolver
} from '../../../browser/browser-network-execution-route'
import { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from './index'
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
  it('registers the authenticated execution-host tunnel in production', () => {
    expect(ALL_RPC_METHODS.some((method) => method.name === 'network.browserTunnel')).toBe(true)
  })

  it('rejects missing capabilities before registering binary traffic', async () => {
    const hostRuntime = runtime()
    const lease = attachLease(hostRuntime)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_NETWORK_TUNNEL_METHODS
    })
    const replies: string[] = []
    const registerBinaryMessageHandler = vi.fn()
    const baseOptions = {
      connectionId: 'connection-a',
      clientKind: 'runtime' as const,
      pairedDeviceId: 'device-a',
      sendBinary: vi.fn(() => true),
      registerBinaryMessageHandler
    }

    await dispatcher.dispatchStreaming(request(lease), (reply) => replies.push(reply), baseOptions)
    await dispatcher.dispatchStreaming(request(lease), (reply) => replies.push(reply), {
      ...baseOptions,
      clientCapabilities: [BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY]
    })

    expect(replies.map((reply) => JSON.parse(reply))).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'browser_tunnel_capability_required' })
      }),
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'browser_client_host_capability_required' })
      })
    ])
    expect(registerBinaryMessageHandler).not.toHaveBeenCalled()
  })

  it('rejects SSH and WSL routing without the execution-host capability', async () => {
    const hostRuntime = runtime()
    const lease = attachLease(hostRuntime)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_NETWORK_TUNNEL_METHODS
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
        clientCapabilities: negotiatedCapabilities,
        sendBinary: vi.fn(() => true),
        registerBinaryMessageHandler
      }
    )
    await dispatcher.dispatchStreaming(
      request(lease, {
        executionHost: {
          kind: 'wsl',
          runtimeId: 'runtime-a',
          revision: 1,
          distro: 'Ubuntu'
        }
      }),
      (reply) => replies.push(reply),
      {
        connectionId: 'connection-a',
        clientKind: 'runtime',
        pairedDeviceId: 'device-a',
        clientCapabilities: negotiatedCapabilities,
        sendBinary: vi.fn(() => true),
        registerBinaryMessageHandler
      }
    )

    expect(replies.map((reply) => JSON.parse(reply))).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: 'browser_tunnel_execution_hosts_capability_required'
        })
      }),
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: 'browser_tunnel_execution_hosts_capability_required'
        })
      })
    ])
    expect(registerBinaryMessageHandler).not.toHaveBeenCalled()
  })

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

  it('opens no binary handler when the execution-host authority is stale', async () => {
    const hostRuntime = runtime()
    const lease = attachLease(hostRuntime)
    const resolveExecutionRoute = vi
      .fn()
      .mockRejectedValue(new Error('browser_tunnel_execution_host_stale'))
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: createBrowserNetworkTunnelMethods(
        new BrowserNetworkTunnelOutboundMemoryBudgetRegistry(),
        resolveExecutionRoute
      )
    })
    const replies: string[] = []
    const registerBinaryMessageHandler = vi.fn()
    const executionHost = {
      kind: 'ssh' as const,
      targetId: 'target-a',
      providerEpoch: 'provider-epoch-a',
      connectionGeneration: 2
    }
    grantExecutionHost(hostRuntime, lease, executionHost)

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
        registerBinaryMessageHandler
      }
    )

    expect(resolveExecutionRoute).toHaveBeenCalledWith({
      executionHost,
      runtimeId: 'runtime-a',
      runtimeRevision: 1,
      signal: expect.any(AbortSignal)
    })
    expect(JSON.parse(replies[0]!).error.message).toBe('browser_tunnel_execution_host_stale')
    expect(registerBinaryMessageHandler).not.toHaveBeenCalled()
  })

  it('closes an invalidated execution route and releases it once', async () => {
    const cleanups = new Map<string, () => void>()
    const hostRuntime = runtime(cleanups)
    const lease = attachLease(hostRuntime)
    const invalidated = new AbortController()
    const closeExecutionRoute = vi.fn()
    const memoryBudgets = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: createBrowserNetworkTunnelMethods(memoryBudgets, async ({ executionHost }) => ({
        key: browserNetworkExecutionHostKey(executionHost),
        connect: () => {
          throw new Error('unexpected destination open')
        },
        whenInvalidated: new Promise((resolve) =>
          invalidated.signal.addEventListener('abort', () => resolve(), { once: true })
        ),
        isValid: () => true,
        close: closeExecutionRoute
      }))
    })
    const unregister = vi.fn()
    const registerBinaryMessageHandler = vi.fn(() => unregister)
    const replies: string[] = []
    const executionHost = {
      kind: 'ssh' as const,
      targetId: 'target-a',
      providerEpoch: 'provider-epoch-a',
      connectionGeneration: 2
    }
    grantExecutionHost(hostRuntime, lease, executionHost)
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
    await vi.waitFor(() => expect(registerBinaryMessageHandler).toHaveBeenCalledOnce())

    invalidated.abort()
    await dispatch

    expect(unregister).toHaveBeenCalledOnce()
    expect(closeExecutionRoute).toHaveBeenCalledOnce()
    expect(memoryBudgets.evidence()).toMatchObject({ hosts: 0, leases: 0 })
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

  it('rejects a self-asserted or stale browser host lease', async () => {
    const hostRuntime = runtime()
    const lease = attachLease(hostRuntime)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_NETWORK_TUNNEL_METHODS
    })
    const replies: string[] = []
    const options = {
      connectionId: 'connection-a',
      clientKind: 'runtime' as const,
      pairedDeviceId: 'device-a',
      clientCapabilities: negotiatedCapabilities,
      sendBinary: vi.fn(() => true),
      registerBinaryMessageHandler: vi.fn(() => vi.fn())
    }

    await dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply), options)
    await dispatcher.dispatchStreaming(
      request(lease, { browserHostGeneration: lease.browserHostGeneration + 1 }),
      (reply) => replies.push(reply),
      options
    )

    expect(replies.map((reply) => JSON.parse(reply))).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'browser_host_lease_stale' })
      }),
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'browser_host_lease_stale' })
      })
    ])
  })

  it('rejects an execution-host revision not owned by this runtime', async () => {
    const hostRuntime = runtime()
    const lease = attachLease(hostRuntime)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_NETWORK_TUNNEL_METHODS
    })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      request(lease, { executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 2 } }),
      (reply) => replies.push(reply),
      {
        connectionId: 'connection-a',
        clientKind: 'runtime',
        pairedDeviceId: 'device-a',
        clientCapabilities: negotiatedCapabilities,
        sendBinary: vi.fn(() => true),
        registerBinaryMessageHandler: vi.fn(() => vi.fn())
      }
    )

    expect(JSON.parse(replies[0]!)).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'browser_tunnel_execution_host_mismatch' })
      })
    )
  })

  it('opens no route or binary handler when process memory admission is exhausted', async () => {
    const hostRuntime = runtime()
    const lease = attachLease(hostRuntime)
    const memoryBudgets = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({
      processMaxLeases: 0
    })
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: createBrowserNetworkTunnelMethods(memoryBudgets)
    })
    const replies: string[] = []
    const registerBinaryMessageHandler = vi.fn()

    await dispatcher.dispatchStreaming(request(lease), (reply) => replies.push(reply), {
      connectionId: 'connection-a',
      clientKind: 'runtime',
      pairedDeviceId: 'device-a',
      clientCapabilities: negotiatedCapabilities,
      sendBinary: vi.fn(() => true),
      registerBinaryMessageHandler
    })

    expect(JSON.parse(replies[0]!)).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'browser_tunnel_memory_admission_failed' })
      })
    )
    expect(registerBinaryMessageHandler).not.toHaveBeenCalled()
    expect(memoryBudgets.evidence()).toMatchObject({ hosts: 0, leases: 0 })
  })

  it('allocates the tunnel generation and removes its raw handler on cleanup', async () => {
    const cleanups = new Map<string, () => void>()
    const hostRuntime = runtime(cleanups)
    const lease = attachLease(hostRuntime)
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: BROWSER_NETWORK_TUNNEL_METHODS
    })
    const unregister = vi.fn()
    const registerBinaryMessageHandler = vi.fn(() => unregister)
    const replies: string[] = []
    const dispatch = dispatcher.dispatchStreaming(request(lease), (reply) => replies.push(reply), {
      connectionId: 'connection-a',
      clientKind: 'runtime',
      pairedDeviceId: 'device-a',
      clientCapabilities: negotiatedCapabilities,
      sendBinary: vi.fn(() => true),
      registerBinaryMessageHandler
    })

    await vi.waitFor(() => expect(registerBinaryMessageHandler).toHaveBeenCalledOnce())
    expect(replies.map((reply) => JSON.parse(reply))).toEqual([
      expect.objectContaining({
        ok: true,
        streaming: true,
        result: { type: 'ready', tunnelGeneration: 1 }
      })
    ])
    cleanups.values().next().value?.()
    await dispatch
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('releases route memory when binary-handler cleanup throws', async () => {
    const cleanups = new Map<string, () => void>()
    const hostRuntime = runtime(cleanups)
    const lease = attachLease(hostRuntime)
    const memoryBudgets = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()
    const dispatcher = new RpcDispatcher({
      runtime: hostRuntime,
      methods: createBrowserNetworkTunnelMethods(memoryBudgets)
    })
    const replies: string[] = []
    const dispatch = dispatcher.dispatchStreaming(request(lease), (reply) => replies.push(reply), {
      connectionId: 'connection-a',
      clientKind: 'runtime',
      pairedDeviceId: 'device-a',
      clientCapabilities: negotiatedCapabilities,
      sendBinary: vi.fn(() => true),
      registerBinaryMessageHandler: vi.fn(() => () => {
        throw new Error('unregister failed')
      })
    })
    await vi.waitFor(() => expect(replies).toHaveLength(1))

    expect(() => cleanups.values().next().value?.()).toThrow('unregister failed')
    await dispatch
    expect(memoryBudgets.evidence()).toMatchObject({ hosts: 0, leases: 0 })
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
