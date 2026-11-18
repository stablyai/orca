import { describe, expect, it, vi } from 'vitest'
import { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import type { BrowserRouteElectronSession } from './browser-route-session-policy'
import type { BrowserRouteSessionRegistryDependencies } from './browser-route-session-registry-contract'

const identity = {
  orcaProfileId: 'orca-profile-a',
  browserProfileId: 'browser-profile-a',
  authorityConnectionIdentity: 'authority-a',
  executionHostIdentity: 'execution-host-a'
}

function createHarness(
  options: {
    resolvedProxy?: string
    maxLivePartitions?: number
    maxPagesPerPartition?: number
    profileError?: Error
    retirementSettled?: boolean
    retirementError?: Error
    proxyProbeStarted?: () => void
    resolveProxyGate?: Promise<void>
  } = {}
) {
  const order: string[] = []
  const bindings = new Map<string, string>()
  let preparingPartition = 'persist:route-a'
  const retirements: Parameters<
    BrowserRouteSessionRegistryDependencies['retirePageAuthority']
  >[0][] = []
  let registry: BrowserRouteSessionRegistry
  const session: BrowserRouteElectronSession = {
    setProxy: vi.fn(async () => {
      order.push('set-proxy')
      expect(registry.isAllowedPartition(preparingPartition)).toBe(false)
    }),
    closeAllConnections: vi.fn(async () => {
      order.push('close-connections')
      expect(registry.isAllowedPartition(preparingPartition)).toBe(false)
    }),
    resolveProxy: vi.fn(async () => {
      order.push('resolve-proxy')
      expect(registry.isAllowedPartition(preparingPartition)).toBe(false)
      options.proxyProbeStarted?.()
      await options.resolveProxyGate
      return options.resolvedProxy ?? 'SOCKS5 127.0.0.1:43123'
    })
  }
  const dependencies: BrowserRouteSessionRegistryDependencies = {
    derivePartition: (input) => ({
      partition:
        input.executionHostIdentity === 'execution-host-b' ? 'persist:route-b' : 'persist:route-a',
      bindingFingerprint:
        input.executionHostIdentity === 'execution-host-b' ? 'b'.repeat(64) : 'a'.repeat(64)
    }),
    validateProfile: vi.fn(() => {
      order.push('validate-profile')
      if (options.profileError) {
        throw options.profileError
      }
    }),
    getSession: vi.fn((partition) => {
      order.push('get-session')
      preparingPartition = partition
      return session
    }),
    setupPolicies: vi.fn(async () => {
      order.push('setup-policies')
    }),
    clearPolicies: vi.fn(() => {
      order.push('clear-policies')
    }),
    retirePageAuthority: vi.fn((retirement) => {
      retirements.push(retirement)
      if (options.retirementError) {
        throw options.retirementError
      }
      return options.retirementSettled ?? true
    }),
    bindingStore: {
      get: vi.fn((partition: string) => bindings.get(partition) ?? null),
      set: vi.fn((partition: string, fingerprint: string) => {
        order.push('persist-binding')
        bindings.set(partition, fingerprint)
        return []
      }),
      touch: vi.fn(),
      findPartitionByFingerprint: vi.fn(() => null),
      rebind: vi.fn()
    },
    maxLivePartitions: options.maxLivePartitions,
    maxPagesPerPartition: options.maxPagesPerPartition
  }
  registry = new BrowserRouteSessionRegistry(dependencies)
  return { bindings, dependencies, order, registry, retirements, session }
}

function prepare(registry: BrowserRouteSessionRegistry, overrides: Record<string, unknown> = {}) {
  return registry.preparePage({
    identity,
    storageScope: 'a'.repeat(64),
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    rendererWebContentsId: 11,
    proxyEndpoint: { host: '127.0.0.1', port: 43123 },
    ...overrides
  })
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: () => resolvePromise?.()
  }
}

describe('BrowserRouteSessionRegistry', () => {
  it('admits a live sibling waiter after fencing a stale pending owner', async () => {
    const probeStarted = deferred()
    const resolveProxyGate = deferred()
    const { dependencies, registry } = createHarness({
      proxyProbeStarted: probeStarted.resolve,
      resolveProxyGate: resolveProxyGate.promise
    })
    const stale = prepare(registry)
    await probeStarted.promise
    const live = prepare(registry, {
      browserPageId: 'page-b',
      pageHostGeneration: 2,
      rendererWebContentsId: 12
    })

    registry.retirePreparedPagesOwnedByRenderer(11)
    resolveProxyGate.resolve()
    await expect(stale).rejects.toThrow('browser_route_partition_renderer_retired')
    const liveHandle = await live
    expect(
      registry.getPreparedPageAuthority({
        partition: liveHandle.partition,
        browserPageId: 'page-b',
        pageHostGeneration: 2,
        rendererWebContentsId: 12
      })
    ).not.toBeNull()
    expect(dependencies.clearPolicies).not.toHaveBeenCalled()
  })

  it('does not resolve a live-partition prepare after owner retirement', async () => {
    const { registry } = createHarness()
    const first = await prepare(registry)

    const preparing = prepare(registry, {
      browserPageId: 'page-b',
      pageHostGeneration: 2
    })
    expect(registry.retirePreparedPagesOwnedByRenderer(11)).toBe(2)

    await expect(preparing).rejects.toThrow('browser_route_partition_renderer_retired')
    expect(registry.isAllowedPartition(first.partition)).toBe(false)
  })

  it('keeps route policy installed until delayed exact-page retirement settles', async () => {
    const { dependencies, registry, retirements } = createHarness({
      maxPagesPerPartition: 1,
      retirementSettled: false
    })
    const handle = await prepare(registry)

    handle.release()
    expect(registry.isAllowedPartition(handle.partition)).toBe(false)
    expect(dependencies.clearPolicies).not.toHaveBeenCalled()
    await expect(prepare(registry)).rejects.toThrow('browser_route_partition_page_retiring')
    await expect(prepare(registry, { browserPageId: 'page-b' })).rejects.toThrow(
      'browser_route_partition_page_capacity'
    )
    expect(retirements).toHaveLength(1)

    retirements[0]?.onRetired()
    expect(dependencies.clearPolicies).toHaveBeenCalledOnce()
    const replacement = await prepare(registry)
    retirements[0]?.onRetired()
    expect(dependencies.clearPolicies).toHaveBeenCalledOnce()
    expect(registry.isAllowedPartition(replacement.partition)).toBe(true)
    replacement.release()
  })
})
