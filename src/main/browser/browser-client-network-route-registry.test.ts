import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import { browserNetworkExecutionHostKey } from './browser-network-execution-route'
import { BrowserClientNetworkRouteRegistry } from './browser-client-network-route-registry'

const authority: BrowserHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 2
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserClientNetworkRouteRegistry', () => {
  it('retains one exact route until its final page releases it', async () => {
    const route = createRoute()
    const routeFactory = vi.fn(() => route)
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      createRoute: routeFactory
    })
    const key = browserNetworkExecutionHostKey({
      kind: 'native',
      runtimeId: 'runtime-a',
      revision: 7
    })

    const first = await registry.retain(key, signal())
    const second = await registry.retain(key, signal())

    expect(routeFactory).toHaveBeenCalledOnce()
    expect(route.start).toHaveBeenCalledOnce()
    expect(route.reconnect).toHaveBeenCalledOnce()
    expect(first).toMatchObject({
      key,
      executionHostIdentity: key,
      proxyEndpoint: { host: '127.0.0.1', port: 43123 }
    })
    await first.release()
    expect(route.close).not.toHaveBeenCalled()
    await second.release()
    expect(route.close).toHaveBeenCalledOnce()
  })

  it('keeps an ambiguously closed route fenced until final registry cleanup', async () => {
    const cleanupError = new Error('route cleanup outcome unknown')
    const route = createRoute()
    let closed = false
    route.close.mockImplementation(async () => {
      closed = true
      throw cleanupError
    })
    route.reconnect.mockImplementation(async () => {
      if (closed) {
        throw new Error('Browser network route is closed')
      }
      return { host: '127.0.0.1', port: 43123 }
    })
    const routeFactory = vi.fn(() => route)
    const registry = new BrowserClientNetworkRouteRegistry({ authority, createRoute: routeFactory })
    const key = browserNetworkExecutionHostKey({
      kind: 'native',
      runtimeId: 'runtime-a',
      revision: 7
    })
    const retained = await registry.retain(key, signal())

    await expect(retained.release()).rejects.toThrow(cleanupError)
    await expect(registry.retain(key, signal())).rejects.toThrow('Browser network route is closed')
    expect(routeFactory).toHaveBeenCalledOnce()

    await expect(registry.close()).rejects.toThrow('Browser client network route cleanup failed')
    expect(route.close).toHaveBeenCalledTimes(3)
  })

  it('rejects a native route for a different authority runtime', async () => {
    const routeFactory = vi.fn(() => createRoute())
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      createRoute: routeFactory
    })
    const key = browserNetworkExecutionHostKey({
      kind: 'native',
      runtimeId: 'runtime-b',
      revision: 1
    })

    await expect(registry.retain(key, signal())).rejects.toThrow(
      'browser_client_network_route_authority_mismatch'
    )
    expect(routeFactory).not.toHaveBeenCalled()
  })

  it('releases an aborted startup without admitting a handle', async () => {
    let resolveStart = (_address: { host: string; port: number }): void => {}
    const route = createRoute(
      new Promise((resolve) => {
        resolveStart = resolve
      })
    )
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      createRoute: () => route
    })
    const controller = new AbortController()
    const retaining = registry.retain(
      browserNetworkExecutionHostKey({ kind: 'native', runtimeId: 'runtime-a', revision: 1 }),
      controller.signal
    )

    controller.abort()
    await expect(retaining).rejects.toThrow('browser_client_network_route_aborted')
    resolveStart({ host: '127.0.0.1', port: 43123 })
    await vi.waitFor(() => expect(route.close).toHaveBeenCalledOnce())
  })

  it('closes every retained route and rejects later admission', async () => {
    const firstRoute = createRoute()
    const secondRoute = createRoute()
    const routeFactory = vi.fn().mockReturnValueOnce(firstRoute).mockReturnValueOnce(secondRoute)
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      createRoute: routeFactory
    })
    await registry.retain(
      browserNetworkExecutionHostKey({ kind: 'native', runtimeId: 'runtime-a', revision: 1 }),
      signal()
    )
    await registry.retain(
      browserNetworkExecutionHostKey({
        kind: 'ssh',
        targetId: 'ssh-a',
        providerEpoch: 'provider-a',
        connectionGeneration: 3
      }),
      signal()
    )

    await registry.close()

    expect(firstRoute.close).toHaveBeenCalledOnce()
    expect(secondRoute.close).toHaveBeenCalledOnce()
    await expect(
      registry.retain(
        browserNetworkExecutionHostKey({ kind: 'native', runtimeId: 'runtime-a', revision: 2 }),
        signal()
      )
    ).rejects.toThrow('browser_client_network_route_registry_closed')
  })

  it('retires old authority routes without destroying them before exact page cleanup', async () => {
    const route = createRoute()
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      createRoute: () => route
    })
    const key = browserNetworkExecutionHostKey({
      kind: 'ssh',
      targetId: 'ssh-a',
      providerEpoch: 'provider-a',
      connectionGeneration: 1
    })
    const retained = await registry.retain(key, signal())

    const retirement = registry.retire(new Error('authority replaced'))

    expect(route.suspend).toHaveBeenCalledOnce()
    expect(route.close).not.toHaveBeenCalled()
    await expect(registry.retain(key, signal())).rejects.toThrow(
      'browser_client_network_route_registry_retired'
    )
    await expect(registry.reconnect()).rejects.toThrow(
      'browser_client_network_route_registry_retired'
    )

    await retained.release()
    await expect(retirement).resolves.toBeUndefined()
    expect(route.close).toHaveBeenCalledOnce()
  })

  it('force-closes retained retired routes during final shutdown', async () => {
    const route = createRoute()
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      createRoute: () => route
    })
    await registry.retain(
      browserNetworkExecutionHostKey({ kind: 'native', runtimeId: 'runtime-a', revision: 1 }),
      signal()
    )

    void registry.retire()
    await registry.close()

    expect(route.close).toHaveBeenCalledOnce()
  })

  it('suspends every retained transport and restores the same listener address', async () => {
    const route = createRoute()
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      createRoute: () => route
    })
    const key = browserNetworkExecutionHostKey({
      kind: 'native',
      runtimeId: 'runtime-a',
      revision: 1
    })
    await registry.retain(key, signal())

    registry.suspend()
    await expect(registry.retain(key, signal())).rejects.toThrow(
      'browser_client_network_route_registry_suspended'
    )
    await registry.reconnect()

    expect(route.suspend).toHaveBeenCalledOnce()
    expect(route.reconnect).toHaveBeenCalledOnce()
    await expect(registry.retain(key, signal())).resolves.toMatchObject({
      proxyEndpoint: { host: '127.0.0.1', port: 43123 }
    })
    await registry.close()
  })

  it('retries one flaky route without closing healthy retained routes', async () => {
    vi.useFakeTimers()
    const flaky = createRoute()
    flaky.reconnect
      .mockRejectedValueOnce(new Error('transient tunnel failure'))
      .mockResolvedValue({ host: '127.0.0.1', port: 43123 })
    const healthy = createRoute()
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      reconnectGraceMs: 1_000,
      reconnectRetryDelayMs: 10,
      createRoute: vi.fn().mockReturnValueOnce(flaky).mockReturnValueOnce(healthy)
    })
    await registry.retain(
      browserNetworkExecutionHostKey({ kind: 'native', runtimeId: 'runtime-a', revision: 1 }),
      signal()
    )
    await registry.retain(
      browserNetworkExecutionHostKey({
        kind: 'ssh',
        targetId: 'ssh-a',
        providerEpoch: 'provider-a',
        connectionGeneration: 1
      }),
      signal()
    )

    registry.suspend()
    const reconnecting = registry.reconnect()
    await vi.runAllTimersAsync()
    await expect(reconnecting).resolves.toBeUndefined()

    expect(flaky.reconnect).toHaveBeenCalledTimes(2)
    expect(healthy.reconnect).toHaveBeenCalledOnce()
    expect(flaky.close).not.toHaveBeenCalled()
    expect(healthy.close).not.toHaveBeenCalled()
    await registry.close()
  })

  it('aborts a stale route recovery without retaining its retry timer', async () => {
    vi.useFakeTimers()
    let rejectReconnect = (_error: Error): void => {}
    const route = createRoute()
    route.reconnect.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectReconnect = reject
      })
    )
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      createRoute: () => route
    })
    await registry.retain(
      browserNetworkExecutionHostKey({ kind: 'native', runtimeId: 'runtime-a', revision: 1 }),
      signal()
    )
    registry.suspend()
    const reconnecting = registry.reconnect()
    await Promise.resolve()

    registry.suspend(new Error('second loss'))
    rejectReconnect(new Error('superseded transport'))

    await expect(reconnecting).rejects.toThrow('browser_client_network_route_recovery_superseded')
    expect(vi.getTimerCount()).toBe(0)
    await registry.close()
  })

  it('fails bounded recovery after one route exhausts grace without leaking timers', async () => {
    vi.useFakeTimers()
    const flaky = createRoute()
    flaky.reconnect.mockRejectedValue(new Error('persistent tunnel failure'))
    const healthy = createRoute()
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      reconnectGraceMs: 25,
      reconnectRetryDelayMs: 10,
      createRoute: vi.fn().mockReturnValueOnce(flaky).mockReturnValueOnce(healthy)
    })
    await registry.retain(
      browserNetworkExecutionHostKey({ kind: 'native', runtimeId: 'runtime-a', revision: 1 }),
      signal()
    )
    await registry.retain(
      browserNetworkExecutionHostKey({
        kind: 'ssh',
        targetId: 'ssh-a',
        providerEpoch: 'provider-a',
        connectionGeneration: 1
      }),
      signal()
    )
    registry.suspend()
    const reconnecting = registry.reconnect()
    const rejected = expect(reconnecting).rejects.toThrow(
      'Browser client network route reconnect failed'
    )

    await vi.runAllTimersAsync()
    await rejected

    expect(flaky.reconnect.mock.calls.length).toBeGreaterThan(1)
    expect(healthy.reconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await registry.close()
  })
})

function createRoute(
  started: Promise<{ host: string; port: number }> = Promise.resolve({
    host: '127.0.0.1',
    port: 43123
  })
) {
  return {
    start: vi.fn(() => started),
    reconnect: vi.fn(() => started),
    suspend: vi.fn(),
    close: vi.fn(async () => {})
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}
