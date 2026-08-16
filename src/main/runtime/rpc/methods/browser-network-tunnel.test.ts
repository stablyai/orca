import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import {
  getBrowserHostLeaseRegistry,
  type BrowserHostLease
} from '../../browser-host-lease-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from './index'
import { BROWSER_NETWORK_TUNNEL_METHODS } from './browser-network-tunnel'

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

const negotiatedCapabilities = [
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
]

describe('network.browserTunnel RPC', () => {
  it('remains outside the production RPC registry until route authorization exists', () => {
    expect(ALL_RPC_METHODS.some((method) => method.name === 'network.browserTunnel')).toBe(false)
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
    cleanups.get('browser-network-tunnel:connection-a')?.()
    await dispatch
    expect(unregister).toHaveBeenCalledOnce()
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
