import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import type {
  RemoteRuntimeSubscription,
  RemoteRuntimeSubscriptionCallbacks
} from '../../shared/remote-runtime-client'

const { subscribeRemoteRuntimeRequestMock } = vi.hoisted(() => ({
  subscribeRemoteRuntimeRequestMock: vi.fn()
}))

vi.mock('../../shared/remote-runtime-client', () => ({
  subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock
}))

import { PairedRuntimeBrowserNetworkRoute } from './paired-runtime-browser-network-route'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from './browser-network-tunnel-outbound-memory-budget'
import { RemoteBrowserSocksServer } from './remote-browser-socks-server'

const pairing = {
  v: 2,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'device-a',
  scope: 'runtime'
} as PairingOffer

const lease = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'host-a',
  browserHostGeneration: 3
}

afterEach(() => {
  subscribeRemoteRuntimeRequestMock.mockReset()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('PairedRuntimeBrowserNetworkRoute', () => {
  it('closes a subscription that resolves after route teardown', async () => {
    let resolveSubscription = (_subscription: RemoteRuntimeSubscription): void => {}
    const closeSubscription = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSubscription = resolve
      })
    )
    const route = new PairedRuntimeBrowserNetworkRoute({
      pairing,
      lease,
      executionHostRevision: 1
    })

    const starting = route.start()
    await route.close()
    resolveSubscription({
      requestId: 'late-subscription',
      close: closeSubscription,
      sendBinary: () => true
    })

    await expect(starting).rejects.toThrow('closed during startup')
    expect(closeSubscription).toHaveBeenCalledOnce()
  })

  it('settles startup when close follows subscription acquisition before readiness', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
    const closeSubscription = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        return {
          requestId: 'waiting-subscription',
          close: closeSubscription,
          sendBinary: () => true
        }
      }
    )
    const route = createRoute()
    const starting = route.start()
    const rejected = expect(starting).rejects.toThrow('closed during startup')
    await vi.waitFor(() => expect(callbacks).toBeDefined())

    await route.close(new Error('closed during startup'))

    await rejected
    expect(closeSubscription).toHaveBeenCalledOnce()
  })

  it('bounds the post-auth readiness wait', async () => {
    vi.useFakeTimers()
    const closeSubscription = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockResolvedValueOnce({
      requestId: 'silent-subscription',
      close: closeSubscription,
      sendBinary: () => true
    })
    const route = createRoute({ timeoutMs: 25 })
    const starting = route.start()
    const rejected = expect(starting).rejects.toThrow('Browser tunnel attach timed out')
    await Promise.resolve()

    await vi.advanceTimersByTimeAsync(25)

    await rejected
    expect(closeSubscription).toHaveBeenCalledOnce()
  })

  it('surfaces listener teardown failures', async () => {
    vi.spyOn(RemoteBrowserSocksServer.prototype, 'close').mockRejectedValueOnce(
      new Error('listener close failed')
    )
    const route = createRoute()

    await expect(route.close()).rejects.toThrow('listener close failed')
  })

  it('tears down the local route when the runtime closes the tunnel', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
    const closeSubscription = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        return {
          requestId: 'runtime-closed-subscription',
          close: closeSubscription,
          sendBinary: () => true
        }
      }
    )
    const onError = vi.fn()
    const route = createRoute({ onError })
    const starting = route.start()
    await vi.waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onResponse({
      id: 'runtime-closed-subscription',
      ok: true,
      result: { type: 'ready', tunnelGeneration: 7 },
      _meta: { runtimeId: 'runtime-a' }
    })
    await starting

    callbacks!.onResponse({
      id: 'runtime-closed-subscription',
      ok: true,
      result: { type: 'closed', tunnelGeneration: 7 },
      _meta: { runtimeId: 'runtime-a' }
    })

    await vi.waitFor(() => expect(closeSubscription).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Browser network route closed by the runtime' })
    )
  })

  it('finishes failure cleanup when reporting and listener teardown both throw', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
    const closeSubscription = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        return {
          requestId: 'cleanup-failure-subscription',
          close: closeSubscription,
          sendBinary: () => true
        }
      }
    )
    const closeSocks = vi
      .spyOn(RemoteBrowserSocksServer.prototype, 'close')
      .mockRejectedValueOnce(new Error('listener close failed'))
    const route = createRoute({
      onError: () => {
        throw new Error('reporting failed')
      }
    })
    const starting = route.start()
    await vi.waitFor(() => expect(callbacks).toBeDefined())
    callbacks!.onResponse({
      id: 'cleanup-failure-subscription',
      ok: true,
      result: { type: 'ready', tunnelGeneration: 7 },
      _meta: { runtimeId: 'runtime-a' }
    })
    await starting

    callbacks!.onClose?.()

    await vi.waitFor(() => expect(closeSubscription).toHaveBeenCalledOnce())
    expect(closeSocks).toHaveBeenCalledOnce()
  })

  it('binds and releases the exact browser-host outbound memory lease', async () => {
    let callbacks: RemoteRuntimeSubscriptionCallbacks | undefined
    let subscriptionOptions: Record<string, unknown> | undefined
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()
    subscribeRemoteRuntimeRequestMock.mockImplementationOnce(
      async (...args: unknown[]): Promise<RemoteRuntimeSubscription> => {
        callbacks = args[4] as RemoteRuntimeSubscriptionCallbacks
        subscriptionOptions = args[5] as Record<string, unknown>
        return { requestId: 'budgeted', close: vi.fn(), sendBinary: () => true }
      }
    )
    const route = createRoute({ outboundMemoryBudgetRegistry: registry })
    const starting = route.start()
    await vi.waitFor(() => expect(callbacks).toBeDefined())

    expect(subscriptionOptions?.outboundMemoryBudget).toBeDefined()
    expect(subscriptionOptions?.outboundQueue).toMatchObject({ maxDrainFramesPerTurn: 4 })
    expect(registry.evidence()).toMatchObject({ hosts: 1, leases: 1 })
    callbacks!.onResponse({
      id: 'budgeted',
      ok: true,
      result: { type: 'ready', tunnelGeneration: 7 },
      _meta: { runtimeId: 'runtime-a' }
    })
    await starting

    await route.close()
    expect(registry.evidence()).toMatchObject({ hosts: 0, leases: 0 })
  })

  it('opens no subscription when browser-host memory admission is exhausted', async () => {
    const registry = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry({ processMaxLeases: 0 })
    const route = createRoute({ outboundMemoryBudgetRegistry: registry })

    await expect(route.start()).rejects.toThrow('outbound memory admission failed')
    expect(subscribeRemoteRuntimeRequestMock).not.toHaveBeenCalled()
  })
})

function createRoute(
  overrides: {
    timeoutMs?: number
    onError?: (error: Error) => void
    outboundMemoryBudgetRegistry?: BrowserNetworkTunnelOutboundMemoryBudgetRegistry
  } = {}
): PairedRuntimeBrowserNetworkRoute {
  return new PairedRuntimeBrowserNetworkRoute({
    pairing,
    lease,
    executionHostRevision: 1,
    ...overrides
  })
}
