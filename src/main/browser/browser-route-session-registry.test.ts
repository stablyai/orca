import { describe, expect, it, vi } from 'vitest'
import {
  BrowserRouteSessionRegistry,
  type BrowserRouteElectronSession,
  type BrowserRouteSessionRegistryDependencies
} from './browser-route-session-registry'

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
    setupError?: Error
    profileError?: Error
    retirementSettled?: boolean
    retirementError?: Error
  } = {}
) {
  const order: string[] = []
  const bindings = new Map<string, string>()
  const retirements: Parameters<
    BrowserRouteSessionRegistryDependencies['retirePageAuthority']
  >[0][] = []
  let registry: BrowserRouteSessionRegistry
  const session: BrowserRouteElectronSession = {
    setProxy: vi.fn(async () => {
      order.push('set-proxy')
      expect(registry.isAllowedPartition('persist:route-a')).toBe(false)
    }),
    closeAllConnections: vi.fn(async () => {
      order.push('close-connections')
      expect(registry.isAllowedPartition('persist:route-a')).toBe(false)
    }),
    resolveProxy: vi.fn(async () => {
      order.push('resolve-proxy')
      expect(registry.isAllowedPartition('persist:route-a')).toBe(false)
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
    getSession: vi.fn(() => {
      order.push('get-session')
      return session
    }),
    setupPolicies: vi.fn(() => {
      order.push('setup-policies')
      if (options.setupError) {
        throw options.setupError
      }
    }),
    clearPolicies: vi.fn(() => order.push('clear-policies')),
    retirePageAuthority: vi.fn((retirement) => {
      retirements.push(retirement)
      if (options.retirementError) {
        throw options.retirementError
      }
      return options.retirementSettled ?? true
    }),
    bindingStore: {
      get: vi.fn((partition) => bindings.get(partition) ?? null),
      set: vi.fn((partition, fingerprint) => {
        order.push('persist-binding')
        bindings.set(partition, fingerprint)
      })
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
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    proxyEndpoint: { host: '127.0.0.1', port: 43123 },
    ...overrides
  })
}

describe('BrowserRouteSessionRegistry', () => {
  it('applies and verifies the exact fail-closed proxy before allowlisting', async () => {
    const { dependencies, order, registry, session } = createHarness()

    const handle = await prepare(registry)

    expect(handle.partition).toBe('persist:route-a')
    expect(order).toEqual([
      'validate-profile',
      'persist-binding',
      'get-session',
      'setup-policies',
      'set-proxy',
      'close-connections',
      'resolve-proxy'
    ])
    expect(session.setProxy).toHaveBeenCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:43123',
      proxyBypassRules: '<-loopback>'
    })
    expect(session.resolveProxy).toHaveBeenCalledWith('http://browser-route-probe.invalid/')
    expect(registry.isAllowedPartition(handle.partition)).toBe(true)

    handle.release()
    expect(registry.isAllowedPartition(handle.partition)).toBe(false)
    expect(dependencies.clearPolicies).toHaveBeenCalledTimes(1)
  })

  it('indexes only exact live page generations by their Electron session', async () => {
    const { registry, session } = createHarness()
    const handle = await prepare(registry)

    expect(registry.getPartitionForSession(session)).toBe(handle.partition)
    expect(
      registry.getPreparedPageAuthority({
        partition: handle.partition,
        browserPageId: 'page-a',
        pageHostGeneration: 1
      })
    ).not.toBeNull()
    expect(
      registry.getPreparedPageAuthority({
        partition: handle.partition,
        browserPageId: 'page-a',
        pageHostGeneration: 2
      })
    ).toBeNull()

    handle.release()
    expect(registry.getPartitionForSession(session)).toBe(handle.partition)
    expect(
      registry.getPreparedPageAuthority({
        partition: handle.partition,
        browserPageId: 'page-a',
        pageHostGeneration: 1
      })
    ).toBeNull()
  })

  it('changes opaque page authority when the same logical tuple is prepared again', async () => {
    const { registry } = createHarness()
    const first = await prepare(registry)
    const firstAuthority = registry.getPreparedPageAuthority({
      partition: first.partition,
      browserPageId: 'page-a',
      pageHostGeneration: 1
    })
    first.release()

    const replacement = await prepare(registry)
    const replacementAuthority = registry.getPreparedPageAuthority({
      partition: replacement.partition,
      browserPageId: 'page-a',
      pageHostGeneration: 1
    })

    expect(firstAuthority).not.toBeNull()
    expect(replacementAuthority).not.toBeNull()
    expect(replacementAuthority).not.toBe(firstAuthority)
    replacement.release()
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

  it('keeps one shared partition live until every page retirement settles', async () => {
    const { dependencies, registry, retirements } = createHarness({
      retirementSettled: false
    })
    const first = await prepare(registry)
    const second = await prepare(registry, { browserPageId: 'page-b' })

    first.release()
    expect(registry.isAllowedPartition(first.partition)).toBe(true)
    retirements[0]?.onRetired()
    expect(dependencies.clearPolicies).not.toHaveBeenCalled()

    second.release()
    expect(registry.isAllowedPartition(first.partition)).toBe(false)
    expect(dependencies.clearPolicies).not.toHaveBeenCalled()
    retirements[1]?.onRetired()
    expect(dependencies.clearPolicies).toHaveBeenCalledOnce()
    retirements[0]?.onRetired()
    expect(dependencies.clearPolicies).toHaveBeenCalledOnce()
  })

  it('fails closed when exact-page retirement cannot be started', async () => {
    const { dependencies, registry } = createHarness({
      retirementError: new Error('retirement unavailable')
    })
    const handle = await prepare(registry)

    expect(() => handle.release()).not.toThrow()
    expect(registry.isAllowedPartition(handle.partition)).toBe(false)
    expect(dependencies.clearPolicies).not.toHaveBeenCalled()
    await expect(prepare(registry)).rejects.toThrow('browser_route_partition_page_retiring')
  })

  it('lets an exact lifecycle event begin the same fenced page retirement', async () => {
    const { registry, retirements } = createHarness({ retirementSettled: false })
    const handle = await prepare(registry)
    const pageAuthority = registry.getPreparedPageAuthority({
      partition: handle.partition,
      browserPageId: 'page-a',
      pageHostGeneration: 1
    })

    expect(
      registry.retirePreparedPage({
        partition: handle.partition,
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        pageAuthority: pageAuthority ?? Symbol('missing')
      })
    ).toBe(true)
    expect(registry.isAllowedPartition(handle.partition)).toBe(false)
    expect(retirements).toHaveLength(1)
    expect(
      registry.retirePreparedPage({
        partition: handle.partition,
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        pageAuthority: pageAuthority ?? Symbol('missing')
      })
    ).toBe(false)
  })

  it('never allowlists a partition whose proxy resolves direct or elsewhere', async () => {
    const { dependencies, registry } = createHarness({ resolvedProxy: 'DIRECT' })

    await expect(prepare(registry)).rejects.toThrow(
      'browser_route_partition_proxy_verification_failed'
    )
    expect(registry.isAllowedPartition('persist:route-a')).toBe(false)
    expect(dependencies.clearPolicies).toHaveBeenCalledTimes(1)
  })

  it('clears partially installed policies when policy setup fails', async () => {
    const { dependencies, registry, session } = createHarness({
      setupError: new Error('policy setup failed')
    })

    await expect(prepare(registry)).rejects.toThrow('policy setup failed')
    expect(session.setProxy).not.toHaveBeenCalled()
    expect(dependencies.clearPolicies).toHaveBeenCalledTimes(1)
    expect(registry.isAllowedPartition('persist:route-a')).toBe(false)
  })

  it('rejects a binding collision before opening an Electron session', async () => {
    const { bindings, dependencies, registry } = createHarness()
    bindings.set('persist:route-a', 'c'.repeat(64))

    await expect(prepare(registry)).rejects.toThrow('browser_route_partition_binding_conflict')
    expect(dependencies.getSession).not.toHaveBeenCalled()
  })

  it('rejects a missing browser profile before consuming durable binding capacity', async () => {
    const { dependencies, registry } = createHarness({
      profileError: new Error('browser_route_partition_profile_unavailable')
    })

    await expect(prepare(registry)).rejects.toThrow('browser_route_partition_profile_unavailable')
    expect(dependencies.bindingStore.set).not.toHaveBeenCalled()
    expect(dependencies.getSession).not.toHaveBeenCalled()
  })

  it('rejects invalid listener and page identities before binding persistence', async () => {
    const { dependencies, registry } = createHarness()

    await expect(
      prepare(registry, { proxyEndpoint: { host: '0.0.0.0', port: 43123 } })
    ).rejects.toThrow('browser_route_partition_proxy_invalid')
    await expect(prepare(registry, { browserPageId: '' })).rejects.toThrow(
      'browser_route_partition_page_invalid'
    )
    await expect(prepare(registry, { pageHostGeneration: 0 })).rejects.toThrow(
      'browser_route_partition_page_invalid'
    )
    expect(dependencies.bindingStore.set).not.toHaveBeenCalled()
    expect(dependencies.getSession).not.toHaveBeenCalled()
  })

  it('shares one prepared partition and fences stale page-handle cleanup', async () => {
    const { dependencies, registry, session } = createHarness()
    const first = await prepare(registry)
    const replacement = await prepare(registry)

    expect(session.setProxy).toHaveBeenCalledTimes(1)
    first.release()
    expect(registry.isAllowedPartition(first.partition)).toBe(true)
    replacement.release()
    expect(registry.isAllowedPartition(first.partition)).toBe(false)
    expect(dependencies.clearPolicies).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent setup and refuses live proxy retargeting', async () => {
    const { registry, session } = createHarness()
    const [first, second] = await Promise.all([
      prepare(registry),
      prepare(registry, { browserPageId: 'page-b' })
    ])

    expect(session.setProxy).toHaveBeenCalledTimes(1)
    await expect(
      prepare(registry, {
        browserPageId: 'page-c',
        proxyEndpoint: { host: '127.0.0.1', port: 43124 }
      })
    ).rejects.toThrow('browser_route_partition_proxy_retarget')
    first.release()
    second.release()
  })

  it('bounds distinct live and pending partitions', async () => {
    const { registry } = createHarness({ maxLivePartitions: 1 })
    const first = await prepare(registry)

    await expect(
      prepare(registry, {
        browserPageId: 'page-b',
        identity: { ...identity, executionHostIdentity: 'execution-host-b' }
      })
    ).rejects.toThrow('browser_route_partition_capacity')
    first.release()
  })

  it('bounds distinct page generations retained by one partition', async () => {
    const { registry } = createHarness({ maxPagesPerPartition: 1 })
    const first = await prepare(registry)

    await expect(prepare(registry, { browserPageId: 'page-b' })).rejects.toThrow(
      'browser_route_partition_page_capacity'
    )
    first.release()
  })
})
