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
    cleanupError?: Error
    setProxyGate?: Promise<void>
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
      await options.setProxyGate
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
    setupPolicies: vi.fn(() => {
      order.push('setup-policies')
      if (options.setupError) {
        throw options.setupError
      }
    }),
    clearPolicies: vi.fn(() => {
      order.push('clear-policies')
      if (options.cleanupError) {
        throw options.cleanupError
      }
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
  reject: (error: Error) => void
  resolve: () => void
} {
  let rejectPromise: ((error: Error) => void) | undefined
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve, reject) => {
    rejectPromise = reject
    resolvePromise = resolve
  })
  return {
    promise,
    reject: (error) => rejectPromise?.(error),
    resolve: () => resolvePromise?.()
  }
}

describe('BrowserRouteSessionRegistry', () => {
  it('rekeys one prepared authority and makes the old release handle inert', async () => {
    const { dependencies, registry } = createHarness()
    const previousHandle = await prepare(registry)
    const previousOwner = {
      partition: previousHandle.partition,
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      rendererWebContentsId: 11
    }
    const pageAuthority = registry.getPreparedPageAuthority(previousOwner)
    expect(pageAuthority).not.toBeNull()
    const nextOwner = { ...previousOwner, pageHostGeneration: 2 }

    const rekeyed = registry.rekeyPreparedPage(
      { ...previousOwner, pageAuthority: pageAuthority! },
      nextOwner
    )

    expect(rekeyed?.page).toMatchObject(nextOwner)
    expect(rekeyed?.page.pageAuthority).toBe(pageAuthority)
    expect(registry.getPreparedPageAuthority(previousOwner)).toBeNull()
    expect(registry.getPreparedPageAuthority(nextOwner)).toBe(pageAuthority)
    previousHandle.release()
    expect(registry.getPreparedPageAuthority(nextOwner)).toBe(pageAuthority)
    rekeyed?.routeSession.release()
    expect(registry.getPreparedPageAuthority(nextOwner)).toBeNull()
    expect(dependencies.clearPolicies).toHaveBeenCalledOnce()
  })

  it('applies and verifies the exact fail-closed proxy before allowlisting', async () => {
    const { dependencies, order, registry, session } = createHarness()

    const handle = await prepare(registry)

    expect(handle.partition).toBe('persist:route-a')
    expect(order).toEqual([
      'validate-profile',
      'persist-binding',
      'get-session',
      'set-proxy',
      'setup-policies',
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
        pageHostGeneration: 1,
        rendererWebContentsId: 11
      })
    ).not.toBeNull()
    expect(
      registry.getPreparedPageAuthority({
        partition: handle.partition,
        browserPageId: 'page-a',
        pageHostGeneration: 2,
        rendererWebContentsId: 11
      })
    ).toBeNull()

    handle.release()
    expect(registry.getPartitionForSession(session)).toBe(handle.partition)
    expect(
      registry.getPreparedPageAuthority({
        partition: handle.partition,
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        rendererWebContentsId: 11
      })
    ).toBeNull()
  })

  it('binds prepared page authority to the exact owning renderer', async () => {
    const { registry } = createHarness()
    const handle = await prepare(registry)
    const page = {
      partition: handle.partition,
      browserPageId: 'page-a',
      pageHostGeneration: 1
    }

    expect(registry.getPreparedPageAuthority({ ...page, rendererWebContentsId: 11 })).not.toBeNull()
    expect(registry.getPreparedPageAuthority({ ...page, rendererWebContentsId: 12 })).toBeNull()
  })

  it('does not move a live page generation to another renderer', async () => {
    const { registry } = createHarness()
    const owned = await prepare(registry)

    await expect(prepare(registry, { rendererWebContentsId: 12 })).rejects.toThrow(
      'browser_route_partition_page_owner_conflict'
    )
    expect(
      registry.getPreparedPageAuthority({
        partition: owned.partition,
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        rendererWebContentsId: 11
      })
    ).not.toBeNull()
  })

  it('retires prepared but unregistered pages when their owning renderer exits', async () => {
    const { registry } = createHarness()
    const owned = await prepare(registry)
    await prepare(registry, {
      browserPageId: 'page-b',
      pageHostGeneration: 2,
      rendererWebContentsId: 12
    })

    expect(registry.retirePreparedPagesOwnedByRenderer(11)).toBe(1)
    expect(
      registry.getPreparedPageAuthority({
        partition: owned.partition,
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        rendererWebContentsId: 11
      })
    ).toBeNull()
    expect(
      registry.getPreparedPageAuthority({
        partition: owned.partition,
        browserPageId: 'page-b',
        pageHostGeneration: 2,
        rendererWebContentsId: 12
      })
    ).not.toBeNull()
  })

  it('continues owner retirement across partitions when policy cleanup throws', async () => {
    const { registry } = createHarness({ cleanupError: new Error('cleanup unavailable') })
    const first = await prepare(registry)
    const second = await prepare(registry, {
      browserPageId: 'page-b',
      pageHostGeneration: 2,
      identity: { ...identity, executionHostIdentity: 'execution-host-b' }
    })

    expect(registry.retirePreparedPagesOwnedByRenderer(11)).toBe(2)
    for (const page of [
      { partition: first.partition, browserPageId: 'page-a', pageHostGeneration: 1 },
      { partition: second.partition, browserPageId: 'page-b', pageHostGeneration: 2 }
    ]) {
      expect(registry.getPreparedPageAuthority({ ...page, rendererWebContentsId: 11 })).toBeNull()
    }
  })

  it('rejects an in-flight prepare after its renderer owner exits', async () => {
    const probeStarted = deferred()
    const resolveProxyGate = deferred()
    const { dependencies, registry } = createHarness({
      proxyProbeStarted: probeStarted.resolve,
      resolveProxyGate: resolveProxyGate.promise
    })
    const preparing = prepare(registry)
    await probeStarted.promise

    expect(registry.retirePreparedPagesOwnedByRenderer(11)).toBe(0)
    resolveProxyGate.resolve()
    await expect(preparing).rejects.toThrow('browser_route_partition_renderer_retired')
    expect(registry.isAllowedPartition('persist:route-a')).toBe(false)
    expect(dependencies.clearPolicies).toHaveBeenCalledOnce()
  })

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

  it('bounds callers waiting on one pending partition setup', async () => {
    const probeStarted = deferred()
    const resolveProxyGate = deferred()
    const { registry } = createHarness({
      maxPagesPerPartition: 1,
      proxyProbeStarted: probeStarted.resolve,
      resolveProxyGate: resolveProxyGate.promise
    })
    const first = prepare(registry)
    await probeStarted.promise

    await expect(prepare(registry, { browserPageId: 'page-b' })).rejects.toThrow(
      'browser_route_partition_pending_capacity'
    )
    resolveProxyGate.resolve()
    const handle = await first
    handle.release()
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

  it('changes opaque page authority when the same logical tuple is prepared again', async () => {
    const { registry } = createHarness()
    const first = await prepare(registry)
    const firstAuthority = registry.getPreparedPageAuthority({
      partition: first.partition,
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      rendererWebContentsId: 11
    })
    first.release()

    const replacement = await prepare(registry)
    const replacementAuthority = registry.getPreparedPageAuthority({
      partition: replacement.partition,
      browserPageId: 'page-a',
      pageHostGeneration: 1,
      rendererWebContentsId: 11
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
      pageHostGeneration: 1,
      rendererWebContentsId: 11
    })

    expect(
      registry.retirePreparedPage({
        partition: handle.partition,
        browserPageId: 'page-a',
        pageHostGeneration: 1,
        rendererWebContentsId: 11,
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
        rendererWebContentsId: 11,
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
    expect(session.setProxy).toHaveBeenCalledTimes(1)
    expect(session.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(dependencies.clearPolicies).toHaveBeenCalledTimes(1)
    expect(registry.isAllowedPartition('persist:route-a')).toBe(false)
  })

  it.each([false, true])(
    'keeps retries joined until failed policy setup settles proxy cleanup (reject: %s)',
    async (rejectProxy) => {
      const proxyGate = deferred()
      const { registry, session } = createHarness({
        setProxyGate: proxyGate.promise,
        setupError: new Error('policy setup failed')
      })

      const first = prepare(registry)
      const retry = prepare(registry, { browserPageId: 'page-b' })
      await vi.waitFor(() => expect(session.setProxy).toHaveBeenCalledTimes(1))
      let settlementCount = 0
      for (const attempt of [first, retry]) {
        void attempt.then(
          () => {
            settlementCount += 1
          },
          () => {
            settlementCount += 1
          }
        )
      }
      await Promise.resolve()
      expect(settlementCount).toBe(0)

      if (rejectProxy) {
        proxyGate.reject(new Error('proxy failed'))
      } else {
        proxyGate.resolve()
      }
      await expect(first).rejects.toThrow('policy setup failed')
      await expect(retry).rejects.toThrow('policy setup failed')
      expect(session.setProxy).toHaveBeenCalledTimes(1)
      expect(session.closeAllConnections).toHaveBeenCalledTimes(1)
    }
  )

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
    await expect(prepare(registry, { rendererWebContentsId: 0 })).rejects.toThrow(
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
