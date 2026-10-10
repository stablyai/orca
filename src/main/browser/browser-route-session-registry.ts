import {
  deriveBrowserRoutePartition,
  type DerivedBrowserRoutePartition
} from './browser-route-identity'
import {
  persistBrowserRouteSessionBinding,
  resolveBrowserRouteSessionPartition
} from './browser-route-session-partition-binding'
import type {
  BrowserRoutePageAuthority,
  BrowserRoutePageOwnerIdentity
} from './browser-route-page-authority'
import {
  assertBrowserRoutePreparedPageOwner,
  BrowserRoutePreparedPageLedger
} from './browser-route-prepared-page-ledger'
import {
  BrowserRouteRendererPrepareFenceRegistry,
  type BrowserRouteRendererPrepareFence
} from './browser-route-renderer-prepare-fence'
import {
  assertBrowserRouteProxyEndpoint,
  prepareBrowserRouteSessionPolicy,
  sameBrowserRouteProxyEndpoint,
  type BrowserRouteElectronSession,
  type BrowserRouteProxyEndpoint as ProxyEndpoint
} from './browser-route-session-policy'
import type { BrowserRouteSessionRegistryDependencies } from './browser-route-session-registry-contract'
import {
  getBrowserRoutePreparedPageAuthority,
  rekeyBrowserRouteSessionPage
} from './browser-route-session-rekey'
import { retireBrowserRouteSessionRendererPages } from './browser-route-session-renderer-retirement'
import { retireBrowserRouteSessionPage } from './browser-route-session-retirement'
import type {
  BrowserRoutePreparePageInput,
  BrowserRouteSessionHandle,
  BrowserRouteSessionRekey,
  PendingBrowserRoutePartition as PendingPartition,
  PreparedBrowserRoutePartition as PreparedPartition
} from './browser-route-session-state'

export type { BrowserRouteElectronSession } from './browser-route-session-policy'
export type {
  BrowserRoutePartitionBindingStore,
  BrowserRouteSessionRegistryDependencies
} from './browser-route-session-registry-contract'

const DEFAULT_MAX_LIVE_PARTITIONS = 64
const DEFAULT_MAX_PAGES_PER_PARTITION = 64
export class BrowserRouteSessionRegistry {
  private readonly derivePartition: NonNullable<
    BrowserRouteSessionRegistryDependencies['derivePartition']
  >
  private readonly maxLivePartitions: number
  private readonly maxPagesPerPartition: number
  private readonly live = new Map<string, PreparedPartition>()
  private readonly pending = new Map<string, PendingPartition>()
  private readonly partitionBySession = new WeakMap<BrowserRouteElectronSession, string>()
  private readonly rendererPrepareFences = new BrowserRouteRendererPrepareFenceRegistry()

  constructor(private readonly dependencies: BrowserRouteSessionRegistryDependencies) {
    this.derivePartition = dependencies.derivePartition ?? deriveBrowserRoutePartition
    this.maxLivePartitions = dependencies.maxLivePartitions ?? DEFAULT_MAX_LIVE_PARTITIONS
    this.maxPagesPerPartition = dependencies.maxPagesPerPartition ?? DEFAULT_MAX_PAGES_PER_PARTITION
  }

  /** True while a partition is prepared or preparing; its storage must not be destroyed. */
  isPartitionRetained(partition: string): boolean {
    return this.live.has(partition) || this.pending.has(partition)
  }

  isAllowedPartition(partition: string): boolean {
    return this.live.get(partition)?.pages.hasActivePages() ?? false
  }

  getPartitionForSession(session: BrowserRouteElectronSession): string | null {
    return this.partitionBySession.get(session) ?? null
  }

  getPreparedPageAuthority(input: BrowserRoutePageOwnerIdentity): symbol | null {
    return getBrowserRoutePreparedPageAuthority(this.live, input)
  }

  rekeyPreparedPage(
    previous: BrowserRoutePageAuthority,
    next: BrowserRoutePageOwnerIdentity
  ): BrowserRouteSessionRekey | null {
    return rekeyBrowserRouteSessionPage(
      this.live,
      previous,
      next,
      this.retirePreparedPage.bind(this)
    )
  }

  retirePreparedPage(input: BrowserRoutePageAuthority): boolean {
    return retireBrowserRouteSessionPage(this.live, input, (state, page) =>
      this.settlePageRetirement(state, page)
    )
  }

  retirePreparedPagesOwnedByRenderer(rendererWebContentsId: number): number {
    return retireBrowserRouteSessionRendererPages({
      rendererWebContentsId,
      rendererPrepareFences: this.rendererPrepareFences,
      live: this.live,
      settle: (state, page) => this.settlePageRetirement(state, page)
    })
  }

  async preparePage(input: BrowserRoutePreparePageInput): Promise<BrowserRouteSessionHandle> {
    assertBrowserRouteProxyEndpoint(input.proxyEndpoint)
    assertBrowserRoutePreparedPageOwner(
      input.browserPageId,
      input.pageHostGeneration,
      input.rendererWebContentsId
    )
    const rendererFence = this.rendererPrepareFences.begin(input.rendererWebContentsId)
    try {
      const handle = await this.preparePageForCurrentRenderer(input, rendererFence)
      rendererFence.assertCurrent()
      return handle
    } finally {
      rendererFence.release()
    }
  }

  private async preparePageForCurrentRenderer(
    input: BrowserRoutePreparePageInput,
    rendererFence: BrowserRouteRendererPrepareFence
  ): Promise<BrowserRouteSessionHandle> {
    this.dependencies.validateProfile(input.identity.browserProfileId)
    const derived = resolveBrowserRouteSessionPartition(
      this.dependencies,
      input,
      this.derivePartition
    )
    let state = this.live.get(derived.partition)
    if (state) {
      this.assertReusable(state, derived, input.proxyEndpoint)
      rendererFence.assertCurrent()
      return this.linkPage(
        state,
        input.browserPageId,
        input.pageHostGeneration,
        input.rendererWebContentsId
      )
    }

    const pending = this.pending.get(derived.partition)
    if (pending) {
      this.assertReusable(pending, derived, input.proxyEndpoint)
      return this.linkPendingPage(pending, input, rendererFence)
    }

    if (this.live.size + this.pending.size >= this.maxLivePartitions) {
      throw new Error('browser_route_partition_capacity')
    }
    persistBrowserRouteSessionBinding(this.dependencies, derived, input.storageScope)
    const promise = this.preparePartition(
      derived,
      input.identity.browserProfileId,
      input.proxyEndpoint
    )
    const pendingState = {
      partition: derived.partition,
      bindingFingerprint: derived.bindingFingerprint,
      proxyEndpoint: input.proxyEndpoint,
      promise,
      state: null,
      waiters: 0,
      admitted: false
    }
    this.pending.set(derived.partition, pendingState)
    return this.linkPendingPage(pendingState, input, rendererFence)
  }

  private async linkPendingPage(
    pending: PendingPartition,
    input: {
      browserPageId: string
      pageHostGeneration: number
      rendererWebContentsId: number
    },
    rendererFence: BrowserRouteRendererPrepareFence
  ): Promise<BrowserRouteSessionHandle> {
    if (pending.waiters >= this.maxPagesPerPartition) {
      throw new Error('browser_route_partition_pending_capacity')
    }
    pending.waiters += 1
    try {
      const state = await pending.promise
      pending.state = state
      rendererFence.assertCurrent()
      if (!pending.admitted) {
        this.live.set(state.partition, state)
        this.partitionBySession.set(state.session, state.partition)
        pending.admitted = true
      }
      try {
        return this.linkPage(
          state,
          input.browserPageId,
          input.pageHostGeneration,
          input.rendererWebContentsId
        )
      } catch (error) {
        this.finalizePartitionIfIdle(state)
        throw error
      }
    } finally {
      pending.waiters -= 1
      if (pending.waiters === 0) {
        if (this.pending.get(pending.partition) === pending) {
          this.pending.delete(pending.partition)
        }
        if (!pending.admitted && pending.state) {
          this.clearUnadmittedPartition(pending.state)
        }
      }
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
    if (!sameBrowserRouteProxyEndpoint(state.proxyEndpoint, proxyEndpoint)) {
      throw new Error('browser_route_partition_proxy_retarget')
    }
  }

  private async preparePartition(
    derived: DerivedBrowserRoutePartition,
    browserProfileId: string,
    proxyEndpoint: ProxyEndpoint
  ): Promise<PreparedPartition> {
    const session = await prepareBrowserRouteSessionPolicy({
      partition: derived.partition,
      browserProfileId,
      proxyEndpoint,
      dependencies: this.dependencies
    })
    return {
      partition: derived.partition,
      bindingFingerprint: derived.bindingFingerprint,
      browserProfileId,
      proxyEndpoint,
      session,
      pages: new BrowserRoutePreparedPageLedger(derived.partition, this.maxPagesPerPartition)
    }
  }

  private linkPage(
    state: PreparedPartition,
    browserPageId: string,
    pageHostGeneration: number,
    rendererWebContentsId: number
  ): BrowserRouteSessionHandle {
    const page = state.pages.link(browserPageId, pageHostGeneration, rendererWebContentsId)
    return {
      partition: state.partition,
      release: () => void this.retirePreparedPage(page)
    }
  }

  private settlePageRetirement(state: PreparedPartition, page: BrowserRoutePageAuthority): void {
    let retired = false
    try {
      retired = this.dependencies.retirePageAuthority({
        ...page,
        onRetired: () => this.completePageRetirement(state, page)
      })
    } catch {
      // Keep route policy installed until exact guest destruction can be confirmed.
    }
    if (retired) {
      state.pages.completeRetirement(page)
    }
    this.finalizePartitionIfIdle(state)
  }

  private completePageRetirement(state: PreparedPartition, page: BrowserRoutePageAuthority): void {
    state.pages.completeRetirement(page)
    this.finalizePartitionIfIdle(state)
  }

  private clearUnadmittedPartition(state: PreparedPartition): void {
    try {
      this.dependencies.clearPolicies({ partition: state.partition, session: state.session })
    } catch {
      // Unadmitted partitions remain outside every route index.
    }
  }

  private finalizePartitionIfIdle(state: PreparedPartition): void {
    if (!state.pages.isIdle() || this.live.get(state.partition) !== state) {
      return
    }
    this.live.delete(state.partition)
    try {
      this.dependencies.clearPolicies({ partition: state.partition, session: state.session })
    } catch {
      // Retired partitions remain outside admission when policy cleanup is unavailable.
    }
  }
}
