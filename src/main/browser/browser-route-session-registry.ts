import {
  deriveBrowserRoutePartition,
  type BrowserRoutePartitionIdentity,
  type DerivedBrowserRoutePartition
} from './browser-route-identity'

const DEFAULT_MAX_LIVE_PARTITIONS = 64
const DEFAULT_MAX_PAGES_PER_PARTITION = 64
const MAX_PAGE_ID_LENGTH = 256
const MAX_PAGE_HOST_GENERATION = 0xffff_ffff
const PROXY_PROBE_URL = 'http://browser-route-probe.invalid/'

export type BrowserRouteElectronSession = {
  setProxy(config: {
    mode: 'fixed_servers'
    proxyRules: string
    proxyBypassRules: string
  }): Promise<void>
  closeAllConnections(): Promise<void>
  resolveProxy(url: string): Promise<string>
}

export type BrowserRoutePartitionBindingStore = {
  get(partition: string): string | null
  set(partition: string, fingerprint: string): void
}

export type BrowserRouteSessionRegistryDependencies = {
  derivePartition?: (identity: BrowserRoutePartitionIdentity) => DerivedBrowserRoutePartition
  validateProfile(browserProfileId: string): void
  getSession(partition: string): BrowserRouteElectronSession
  setupPolicies(input: {
    partition: string
    browserProfileId: string
    session: BrowserRouteElectronSession
  }): void
  clearPolicies(input: { partition: string; session: BrowserRouteElectronSession }): void
  bindingStore: BrowserRoutePartitionBindingStore
  maxLivePartitions?: number
  maxPagesPerPartition?: number
}

export type BrowserRouteSessionHandle = Readonly<{
  partition: string
  release: () => void
}>

type ProxyEndpoint = Readonly<{ host: '127.0.0.1'; port: number }>

type PreparedPartition = {
  partition: string
  bindingFingerprint: string
  browserProfileId: string
  proxyEndpoint: ProxyEndpoint
  session: BrowserRouteElectronSession
  pageTokens: Map<string, symbol>
}

type PendingPartition = {
  bindingFingerprint: string
  proxyEndpoint: ProxyEndpoint
  promise: Promise<PreparedPartition>
}

export class BrowserRouteSessionRegistry {
  private readonly derivePartition: NonNullable<
    BrowserRouteSessionRegistryDependencies['derivePartition']
  >
  private readonly maxLivePartitions: number
  private readonly maxPagesPerPartition: number
  private readonly live = new Map<string, PreparedPartition>()
  private readonly pending = new Map<string, PendingPartition>()
  private readonly partitionBySession = new WeakMap<BrowserRouteElectronSession, string>()

  constructor(private readonly dependencies: BrowserRouteSessionRegistryDependencies) {
    this.derivePartition = dependencies.derivePartition ?? deriveBrowserRoutePartition
    this.maxLivePartitions = dependencies.maxLivePartitions ?? DEFAULT_MAX_LIVE_PARTITIONS
    this.maxPagesPerPartition = dependencies.maxPagesPerPartition ?? DEFAULT_MAX_PAGES_PER_PARTITION
  }

  isAllowedPartition(partition: string): boolean {
    return this.live.has(partition)
  }

  getPartitionForSession(session: BrowserRouteElectronSession): string | null {
    return this.partitionBySession.get(session) ?? null
  }

  getPreparedPageAuthority(input: {
    partition: string
    browserPageId: string
    pageHostGeneration: number
  }): symbol | null {
    const state = this.live.get(input.partition)
    if (!state || !isValidPageIdentity(input.browserPageId, input.pageHostGeneration)) {
      return null
    }
    return state.pageTokens.get(pageKey(input.browserPageId, input.pageHostGeneration)) ?? null
  }

  async preparePage(input: {
    identity: BrowserRoutePartitionIdentity
    browserPageId: string
    pageHostGeneration: number
    proxyEndpoint: ProxyEndpoint
  }): Promise<BrowserRouteSessionHandle> {
    assertProxyEndpoint(input.proxyEndpoint)
    assertPageIdentity(input.browserPageId, input.pageHostGeneration)
    const derived = this.derivePartition(input.identity)
    this.dependencies.validateProfile(input.identity.browserProfileId)
    this.assertBinding(derived)
    let state = this.live.get(derived.partition)
    if (state) {
      this.assertReusable(state, derived, input.proxyEndpoint)
      return this.linkPage(state, input.browserPageId, input.pageHostGeneration)
    }

    const pending = this.pending.get(derived.partition)
    if (pending) {
      this.assertReusable(pending, derived, input.proxyEndpoint)
      state = await pending.promise
      return this.linkPage(state, input.browserPageId, input.pageHostGeneration)
    }

    if (this.live.size + this.pending.size >= this.maxLivePartitions) {
      throw new Error('browser_route_partition_capacity')
    }
    if (this.dependencies.bindingStore.get(derived.partition) === null) {
      this.dependencies.bindingStore.set(derived.partition, derived.bindingFingerprint)
    }
    const promise = this.preparePartition(
      derived,
      input.identity.browserProfileId,
      input.proxyEndpoint
    )
    const pendingState = {
      bindingFingerprint: derived.bindingFingerprint,
      proxyEndpoint: input.proxyEndpoint,
      promise
    }
    this.pending.set(derived.partition, pendingState)
    try {
      state = await promise
      this.live.set(derived.partition, state)
      this.partitionBySession.set(state.session, state.partition)
    } finally {
      if (this.pending.get(derived.partition) === pendingState) {
        this.pending.delete(derived.partition)
      }
    }
    return this.linkPage(state, input.browserPageId, input.pageHostGeneration)
  }

  private assertBinding(derived: DerivedBrowserRoutePartition): void {
    const persisted = this.dependencies.bindingStore.get(derived.partition)
    if (persisted !== null && persisted !== derived.bindingFingerprint) {
      throw new Error('browser_route_partition_binding_conflict')
    }
  }

  private assertReusable(
    state: Pick<PreparedPartition, 'bindingFingerprint' | 'proxyEndpoint'>,
    derived: DerivedBrowserRoutePartition,
    proxyEndpoint: ProxyEndpoint
  ): void {
    if (state.bindingFingerprint !== derived.bindingFingerprint) {
      throw new Error('browser_route_partition_binding_conflict')
    }
    if (!sameProxyEndpoint(state.proxyEndpoint, proxyEndpoint)) {
      throw new Error('browser_route_partition_proxy_retarget')
    }
  }

  private async preparePartition(
    derived: DerivedBrowserRoutePartition,
    browserProfileId: string,
    proxyEndpoint: ProxyEndpoint
  ): Promise<PreparedPartition> {
    const session = this.dependencies.getSession(derived.partition)
    try {
      this.dependencies.setupPolicies({ partition: derived.partition, browserProfileId, session })
      await session.setProxy({
        mode: 'fixed_servers',
        proxyRules: `socks5://${proxyEndpoint.host}:${proxyEndpoint.port}`,
        proxyBypassRules: '<-loopback>'
      })
      await session.closeAllConnections()
      const resolved = await session.resolveProxy(PROXY_PROBE_URL)
      if (resolved.trim() !== `SOCKS5 ${proxyEndpoint.host}:${proxyEndpoint.port}`) {
        throw new Error('browser_route_partition_proxy_verification_failed')
      }
    } catch (error) {
      try {
        this.dependencies.clearPolicies({ partition: derived.partition, session })
      } catch {
        // The partition remains outside the allowlist even if policy cleanup fails.
      }
      throw error
    }
    return {
      partition: derived.partition,
      bindingFingerprint: derived.bindingFingerprint,
      browserProfileId,
      proxyEndpoint,
      session,
      pageTokens: new Map()
    }
  }

  private linkPage(
    state: PreparedPartition,
    browserPageId: string,
    pageHostGeneration: number
  ): BrowserRouteSessionHandle {
    const key = pageKey(browserPageId, pageHostGeneration)
    if (!state.pageTokens.has(key) && state.pageTokens.size >= this.maxPagesPerPartition) {
      throw new Error('browser_route_partition_page_capacity')
    }
    const token = Symbol(key)
    state.pageTokens.set(key, token)
    return {
      partition: state.partition,
      release: () => {
        if (state.pageTokens.get(key) !== token) {
          return
        }
        state.pageTokens.delete(key)
        if (state.pageTokens.size !== 0 || this.live.get(state.partition) !== state) {
          return
        }
        this.live.delete(state.partition)
        this.dependencies.clearPolicies({ partition: state.partition, session: state.session })
      }
    }
  }
}

function assertProxyEndpoint(
  endpoint: Readonly<{ host: string; port: number }>
): asserts endpoint is ProxyEndpoint {
  if (
    endpoint.host !== '127.0.0.1' ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65_535
  ) {
    throw new Error('browser_route_partition_proxy_invalid')
  }
}

function sameProxyEndpoint(left: ProxyEndpoint, right: ProxyEndpoint): boolean {
  return left.host === right.host && left.port === right.port
}

function assertPageIdentity(browserPageId: string, pageHostGeneration: number): void {
  if (!isValidPageIdentity(browserPageId, pageHostGeneration)) {
    throw new Error('browser_route_partition_page_invalid')
  }
}

function isValidPageIdentity(browserPageId: string, pageHostGeneration: number): boolean {
  return (
    typeof browserPageId === 'string' &&
    browserPageId.length > 0 &&
    browserPageId.length <= MAX_PAGE_ID_LENGTH &&
    Number.isInteger(pageHostGeneration) &&
    pageHostGeneration >= 1 &&
    pageHostGeneration <= MAX_PAGE_HOST_GENERATION
  )
}

function pageKey(browserPageId: string, pageHostGeneration: number): string {
  return JSON.stringify([browserPageId, pageHostGeneration])
}
