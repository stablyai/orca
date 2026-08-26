import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import { browserNetworkExecutionHostStorageIdentity } from './browser-execution-host-storage-identity'
import { browserNetworkExecutionHostKey } from './browser-network-execution-route'
import { BrowserClientNetworkRouteRegistry } from './browser-client-network-route-registry'

const authority: BrowserHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 2
}
const authorityStorageKey = 'a'.repeat(64)

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserClientNetworkRouteRegistry', () => {
  it('retains one exact route until its final page releases it', async () => {
    const route = createRoute()
    const routeFactory = vi.fn(() => route)
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
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
      executionHostIdentity: browserNetworkExecutionHostStorageIdentity(
        { kind: 'native', runtimeId: 'runtime-a', revision: 7 },
        authorityStorageKey
      ),
      proxyEndpoint: { host: '127.0.0.1', port: 43123 }
    })
    expect(first.executionHostIdentity).not.toBe(key)
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
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: routeFactory
    })
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

  it('rejects native and WSL routes for a different authority runtime', async () => {
    const routeFactory = vi.fn(() => createRoute())
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
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
    const wslKey = browserNetworkExecutionHostKey({
      kind: 'wsl',
      runtimeId: 'runtime-b',
      revision: 1,
      distro: 'Ubuntu'
    })
    await expect(registry.retain(wslKey, signal())).rejects.toThrow(
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
      authorityStorageKey,
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
      authorityStorageKey,
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
      authorityStorageKey,
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
      authorityStorageKey,
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
      authorityStorageKey,
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
      authorityStorageKey,
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
      authorityStorageKey,
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
      authorityStorageKey,
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

  it('mints a fresh route for a retain that lands while the previous one is closing', async () => {
    const teardown = deferredTeardown()
    const closing = createRoute()
    closing.close.mockImplementation(() => teardown.promise)
    closing.reconnect.mockRejectedValue(new Error('Browser network route is closed'))
    const replacement = createRoute(Promise.resolve({ host: '127.0.0.1', port: 43124 }))
    const routeFactory = vi.fn(() => (routeFactory.mock.calls.length > 1 ? replacement : closing))
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: routeFactory
    })
    const key = browserNetworkExecutionHostKey({
      kind: 'ssh',
      targetId: 'target-a',
      providerEpoch: 'provider-a',
      connectionGeneration: 2
    })
    const retained = await registry.retain(key, signal())

    const releasing = retained.release()
    const retaining = registry.retain(key, signal())
    teardown.resolve()

    await releasing
    await expect(retaining).resolves.toMatchObject({ proxyEndpoint: { port: 43124 } })
    expect(closing.reconnect).not.toHaveBeenCalled()
    expect(replacement.start).toHaveBeenCalledOnce()
    await registry.close()
  })

  it('waits for a route still closing before reporting retirement', async () => {
    const teardown = deferredTeardown()
    const route = createRoute()
    route.close.mockImplementation(() => teardown.promise)
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: vi.fn(() => route)
    })
    const key = browserNetworkExecutionHostKey({
      kind: 'native',
      runtimeId: 'runtime-a',
      revision: 7
    })
    const retained = await registry.retain(key, signal())

    const releasing = retained.release()
    let retired = false
    void registry.retire().then(() => {
      retired = true
    })
    await Promise.resolve()

    expect(retired).toBe(false)
    teardown.resolve()
    await releasing
    await registry.retire()
    expect(retired).toBe(true)
  })

  it('refuses a retain whose signal aborted before admission', async () => {
    const routeFactory = vi.fn(() => createRoute())
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: routeFactory
    })
    const controller = new AbortController()
    controller.abort()

    await expect(registry.retain(nativeKey(1), controller.signal)).rejects.toThrow(
      'browser_client_network_route_aborted'
    )
    expect(routeFactory).not.toHaveBeenCalled()
  })

  it('rejects a retain the moment its signal aborts mid-startup', async () => {
    let resolveStart = (_address: { host: string; port: number }): void => {}
    const route = createRoute(
      new Promise((resolve) => {
        resolveStart = resolve
      })
    )
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: () => route
    })
    const controller = new AbortController()
    const retaining = registry.retain(nativeKey(1), controller.signal)
    await flushMicrotasks()

    controller.abort()

    await expect(retaining).rejects.toThrow('browser_client_network_route_aborted')
    resolveStart({ host: '127.0.0.1', port: 43123 })
    await vi.waitFor(() => expect(route.close).toHaveBeenCalledOnce())
  })

  it('refuses a retain that waited out a closing route onto a retired registry', async () => {
    const teardown = deferredTeardown()
    const route = createRoute()
    route.close.mockImplementation(() => teardown.promise)
    const routeFactory = vi.fn(() => route)
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: routeFactory
    })
    const key = nativeKey(7)
    const retained = await registry.retain(key, signal())
    const releasing = retained.release()
    const retaining = registry.retain(key, signal())

    void registry.retire(new Error('authority replaced'))
    teardown.resolve()
    await releasing

    await expect(retaining).rejects.toThrow('browser_client_network_route_registry_retired')
    // A retired registry must never mint the replacement route the waiter was queued for.
    expect(routeFactory).toHaveBeenCalledOnce()
    expect(route.start).toHaveBeenCalledOnce()
  })

  it('keeps a fully released key clean so final cleanup closes it only once', async () => {
    const route = createRoute()
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: vi.fn(() => route)
    })
    const retained = await registry.retain(nativeKey(1), signal())

    await retained.release()
    expect(route.close).toHaveBeenCalledOnce()

    await registry.close()
    expect(route.close).toHaveBeenCalledOnce()
  })

  it('never re-closes a route the registry already force-closed', async () => {
    const route = createRoute()
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: vi.fn(() => route)
    })
    const key = nativeKey(1)
    const first = await registry.retain(key, signal())
    const second = await registry.retain(key, signal())

    await registry.close()
    await first.release()
    await second.release()

    expect(route.close).toHaveBeenCalledOnce()
  })

  it('ignores a repeated release from the same page handle', async () => {
    const route = createRoute()
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: vi.fn(() => route)
    })
    const key = nativeKey(1)
    const first = await registry.retain(key, signal())
    const second = await registry.retain(key, signal())

    await first.release()
    await first.release()
    expect(route.close).not.toHaveBeenCalled()

    await second.release()
    expect(route.close).toHaveBeenCalledOnce()
  })

  it('refuses a retain whose route came back on a different port', async () => {
    const route = createRoute()
    route.reconnect.mockResolvedValue({ host: '127.0.0.1', port: 43999 })
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: vi.fn(() => route)
    })
    const key = nativeKey(1)
    await registry.retain(key, signal())

    await expect(registry.retain(key, signal())).rejects.toThrow(
      'browser_client_network_route_address_changed'
    )
  })

  it('refuses a reconnect that moved a retained route to a different port', async () => {
    const route = createRoute()
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: vi.fn(() => route)
    })
    await registry.retain(nativeKey(1), signal())
    registry.suspend()
    route.reconnect.mockResolvedValue({ host: '127.0.0.1', port: 43999 })

    await expect(registry.reconnect()).rejects.toThrow(
      'browser_client_network_route_address_changed'
    )
  })

  it('fails retirement when a route refuses to suspend', async () => {
    const route = createRoute()
    route.suspend.mockImplementation(() => {
      throw new Error('suspend refused')
    })
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: vi.fn(() => route)
    })
    await registry.retain(nativeKey(1), signal())

    expect(() => registry.retire()).toThrow('Browser client network route suspension failed')

    // A second retire must report the same failure without re-suspending an already suspended route.
    await expect(registry.retire()).rejects.toThrow(
      'Browser client network route suspension failed'
    )
    expect(route.suspend).toHaveBeenCalledOnce()
  })

  it('reports a failed final cleanup to an awaiting retirement', async () => {
    const route = createRoute()
    route.close.mockRejectedValue(new Error('route cleanup outcome unknown'))
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: vi.fn(() => route)
    })
    await registry.retain(nativeKey(1), signal())
    let retirementFailure: string | undefined
    void registry.retire().catch((error: Error) => {
      retirementFailure = error.message
    })

    await expect(registry.close()).rejects.toThrow('Browser client network route cleanup failed')
    await flushMicrotasks()

    expect(retirementFailure).toBe('Browser client network route cleanup failed')
  })

  it('refuses to report retirement for a registry whose close already failed', async () => {
    const route = createRoute()
    route.close.mockRejectedValue(new Error('route cleanup outcome unknown'))
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: vi.fn(() => route)
    })
    await registry.retain(nativeKey(1), signal())

    await expect(registry.close()).rejects.toThrow('Browser client network route cleanup failed')

    await expect(registry.retire()).rejects.toThrow('Browser client network route cleanup failed')
  })

  it('surfaces both the retain failure and its cleanup failure', async () => {
    const route = createRoute()
    route.start.mockRejectedValue(new Error('tunnel start failed'))
    route.close.mockRejectedValue(new Error('route cleanup outcome unknown'))
    const registry = new BrowserClientNetworkRouteRegistry({
      authority,
      authorityStorageKey,
      createRoute: vi.fn(() => route)
    })

    await expect(registry.retain(nativeKey(1), signal())).rejects.toMatchObject({
      message: 'tunnel start failed',
      errors: [
        expect.objectContaining({ message: 'tunnel start failed' }),
        expect.objectContaining({ message: 'route cleanup outcome unknown' })
      ]
    })
  })
})

function nativeKey(revision: number): string {
  return browserNetworkExecutionHostKey({ kind: 'native', runtimeId: 'runtime-a', revision })
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

function deferredTeardown(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

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
