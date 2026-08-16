import { describe, expect, it, vi } from 'vitest'
import type { BrowserHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import { browserNetworkExecutionHostKey } from './browser-network-execution-route'
import { BrowserClientNetworkRouteRegistry } from './browser-client-network-route-registry'

const authority: BrowserHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'client-a',
  browserHostGeneration: 2
}

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
    close: vi.fn(async () => {})
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}
