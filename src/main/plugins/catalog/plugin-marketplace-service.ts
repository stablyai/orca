import { runSourceRefresh } from './plugin-marketplace-refresh-queue'
import { readMarketplaceSnapshots } from './plugin-marketplace-snapshots'
import { PluginCatalogRepositoryStore } from './plugin-catalog-repository'
import {
  OFFICIAL_MARKETPLACE_GIT_SOURCE,
  isMarketplaceListingSupported,
  isOfficialMarketplaceGitSource,
  pluginMarketplaceGitSourceSchema,
  type PluginMarketplaceEntry,
  type PluginMarketplaceGitSource
} from '../../../shared/plugins/catalog/plugin-marketplace'
import {
  fetchPluginMarketplace,
  type PluginMarketplaceFetchResult
} from './plugin-marketplace-fetch'
import {
  marketplaceSourceId,
  PluginMarketplaceStore,
  type CatalogRepositorySlot,
  type PluginMarketplaceCachedSnapshot,
  type PluginMarketplaceRegisteredSource
} from './plugin-marketplace-store'
import type {
  PluginBlockNotice,
  PluginKillListEntry
} from '../../../shared/plugins/catalog/plugin-kill-list'
import { validateMarketplaceProvenance } from './plugin-marketplace-provenance'
import { CommunityMarketplaceSeed } from './plugin-community-marketplace-seed'
import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from '../../../shared/plugins/catalog/plugin-install-link'
import type { OrcaCloudCapabilities } from '../../../shared/orca-profiles/orca-cloud-capabilities'
import { PluginMarketplaceTeamPolicy } from './plugin-marketplace-team-policy'
import { pluginMarketplaceErrorMessage } from './plugin-marketplace-error-message'
import { sharedSourceRefresh } from './plugin-marketplace-shared-refresh'
import {
  pluginMarketplaceListing,
  pluginMarketplaceSourceState,
  type PluginMarketplaceListing,
  type PluginMarketplaceSourceState
} from './plugin-marketplace-projection'
export type {
  PluginMarketplaceListing,
  PluginMarketplaceSourceState
} from './plugin-marketplace-projection'

type MarketplaceFetcher = (
  source: PluginMarketplaceRegisteredSource
) => Promise<PluginMarketplaceFetchResult>

export class PluginMarketplaceService {
  private readonly store: PluginMarketplaceStore
  private readonly repositories: PluginCatalogRepositoryStore | null
  private readonly fetcher?: MarketplaceFetcher
  private readonly repositorySweep?: Promise<void>
  private readonly getKillListEntry: (pluginKey: string) => (PluginKillListEntry & PluginBlockNotice) | null
  private readonly hostVersion: string | null
  private readonly refreshChains = new Map<string, Promise<PluginMarketplaceSourceState>>()
  private readonly removingSources = new Set<string>()
  private readonly sourceErrors = new Map<string, string>()
  private officialSeedPromise: Promise<PluginMarketplaceSourceState> | null = null
  private officialSeedRequested = false
  private readonly communitySeed: CommunityMarketplaceSeed
  private readonly teamPolicy: PluginMarketplaceTeamPolicy

  constructor(options: {
    pluginsDataDir: string
    fetcher?: MarketplaceFetcher
    store?: PluginMarketplaceStore
    getKillListEntry?: (pluginKey: string) => (PluginKillListEntry & PluginBlockNotice) | null
    /** Picks which of an entry's releases to offer; without it the newest is offered. */
    hostVersion?: string
    repositories?: PluginCatalogRepositoryStore
    getTeamCapabilities?: () => OrcaCloudCapabilities | undefined
  }) {
    this.hostVersion = options.hostVersion ?? null
    this.store = options.store ?? new PluginMarketplaceStore(options.pluginsDataDir)
    const repositories =
      options.repositories ??
      (options.fetcher ? null : new PluginCatalogRepositoryStore(options.pluginsDataDir))
    this.repositories = repositories
    this.fetcher = options.fetcher
    this.repositorySweep = repositories?.sweep(this.store.listSources()).catch((error: unknown) => {
      console.warn('[plugins] could not sweep retained catalog repositories:', error)
    })
    this.getKillListEntry = options.getKillListEntry ?? (() => null)
    this.teamPolicy = new PluginMarketplaceTeamPolicy(options.getTeamCapabilities)
    this.communitySeed = new CommunityMarketplaceSeed(this.store, (source) =>
      this.addSource(source)
    )
  }

  async listSources(): Promise<PluginMarketplaceSourceState[]> {
    await this.waitForOfficialSeed()
    const sources = await this.teamPolicy.list(this.store)
    return Promise.all(
      sources.map(async (source) => {
        let error = this.sourceErrors.get(source.id)
        const snapshot = await this.store.readSnapshot(source.id).catch((cause) => {
          error = pluginMarketplaceErrorMessage(cause)
          return null
        })
        return pluginMarketplaceSourceState(source, snapshot, error, this.teamPolicy)
      })
    )
  }

  async addSource(source: PluginMarketplaceGitSource): Promise<PluginMarketplaceSourceState> {
    const parsedSource = pluginMarketplaceGitSourceSchema.parse(source)
    if (!this.teamPolicy.allows(parsedSource)) {
      throw new Error('This plugin catalog is turned off by your team.')
    }
    const sourceId = marketplaceSourceId(parsedSource)
    return runSourceRefresh(this.refreshChains, this.removingSources, sourceId, () =>
      this.performAddSource(sourceId, parsedSource)
    )
  }

  private async performAddSource(
    sourceId: string,
    parsedSource: PluginMarketplaceGitSource
  ): Promise<PluginMarketplaceSourceState> {
    const existing = (await this.store.listSources()).find((candidate) => candidate.id === sourceId)
    const candidate: PluginMarketplaceRegisteredSource = existing ?? {
      id: sourceId,
      source: parsedSource,
      addedAt: Date.now()
    }
    try {
      const snapshot = await this.refreshSnapshot(candidate, () => {
        if (!this.teamPolicy.allows(parsedSource)) {
          throw new Error('This plugin catalog is turned off by your team.')
        }
        return existing ?? this.store.addSource(parsedSource, candidate.addedAt)
      })
      this.sourceErrors.delete(candidate.id)
      return pluginMarketplaceSourceState(candidate, snapshot, undefined, this.teamPolicy)
    } catch (error) {
      if (!existing) {
        await this.store.removeSource(sourceId).catch(() => undefined)
        await this.repositories?.remove(sourceId).catch(() => undefined)
      }
      throw error
    }
  }

  allowsSource(source: PluginMarketplaceGitSource): boolean {
    return this.teamPolicy.allows(source)
  }

  async removeSource(sourceId: string): Promise<boolean> {
    if (this.teamPolicy.isManaged(sourceId)) {
      throw new Error('This plugin catalog is managed by your team.')
    }
    const source = (await this.store.listSources()).find((candidate) => candidate.id === sourceId)
    if (source && isOfficialMarketplaceGitSource(source.source.url)) {
      throw new Error('the official marketplace is managed by Orca and cannot be removed')
    }
    this.removingSources.add(sourceId)
    try {
      await this.repositorySweep
      await this.refreshChains.get(sourceId)?.catch(() => undefined)
      const removed = await this.store.removeSource(sourceId)
      await this.repositories?.remove(sourceId)
      if (removed) {
        this.sourceErrors.delete(sourceId)
        if (this.officialSeedRequested) {
          // Recover the managed source when a full profile frees a slot, without restart.
          await this.seedOfficialSource().catch(() => undefined)
        }
      }
      return removed
    } finally {
      this.removingSources.delete(sourceId)
    }
  }

  seedOfficialSource(): Promise<PluginMarketplaceSourceState> {
    if (!this.teamPolicy.allows(OFFICIAL_MARKETPLACE_GIT_SOURCE)) {
      return Promise.reject(new Error('The official plugin catalog is turned off by your team.'))
    }
    this.officialSeedRequested = true
    if (!this.officialSeedPromise) {
      const seed = this.performOfficialSeed()
      this.officialSeedPromise = seed
      void seed.catch(() => {
        if (this.officialSeedPromise === seed) {
          // Store/full-list failures must permit later seeding attempts.
          this.officialSeedPromise = null
        }
      })
    }
    return this.officialSeedPromise
  }

  /** Adds the community catalog once by default; see CommunityMarketplaceSeed. */
  seedCommunitySource(now?: number): Promise<void> {
    return this.teamPolicy.allows(COMMUNITY_MARKETPLACE_GIT_SOURCE)
      ? this.communitySeed.run(now)
      : Promise.resolve()
  }

  async refreshSource(sourceId: string): Promise<PluginMarketplaceSourceState> {
    return runSourceRefresh(this.refreshChains, this.removingSources, sourceId, () =>
      this.performRefresh(sourceId)
    )
  }

  /** See sharedSourceRefresh: one update review's previews share one catalog fetch. */
  readonly refreshSourceShared = sharedSourceRefresh((sourceId) => this.refreshSource(sourceId))

  async refreshAll(): Promise<PluginMarketplaceSourceState[]> {
    await this.waitForOfficialSeed()
    const sources = await this.teamPolicy.list(this.store)
    return Promise.all(sources.map((source) => this.refreshSource(source.id)))
  }

  async listPlugins(): Promise<PluginMarketplaceListing[]> {
    await this.waitForOfficialSeed()
    return (await this.listCachedPlugins()).sort((left, right) =>
      `${left.pluginKey}\0${left.marketplaceSourceId}`.localeCompare(
        `${right.pluginKey}\0${right.marketplaceSourceId}`
      )
    )
  }

  /** Listings from the cached catalogs in catalog order, without waiting on any fetch. */
  async listCachedPlugins(pluginKeys?: ReadonlySet<string>): Promise<PluginMarketplaceListing[]> {
    const states = await readMarketplaceSnapshots(
      this.store,
      await this.teamPolicy.list(this.store)
    )
    return states.flatMap(({ source, snapshot }) =>
      snapshot.marketplace.plugins
        // Why: hide packs whose contribution kind this build no longer
        // supports (themes/icons/skills) so users never reach a dead install.
        .filter(
          (entry) =>
            (!pluginKeys || pluginKeys.has(entry.id)) &&
            isMarketplaceListingSupported(entry.categories)
        )
        .flatMap((entry) => this.listingFromEntry(source, snapshot, entry) ?? [])
    )
  }

  async findPlugin(
    marketplaceSourceId: string,
    pluginKey: string
  ): Promise<PluginMarketplaceListing | null> {
    const source = (await this.teamPolicy.list(this.store)).find(
      (candidate) => candidate.id === marketplaceSourceId
    )
    if (!source) {
      return null
    }
    const snapshot = await this.store.readSnapshot(source.id)
    // Preview/install key lookups must reject unsupported packs too.
    const entry = snapshot?.marketplace.plugins.find(
      (plugin) => plugin.id === pluginKey && isMarketplaceListingSupported(plugin.categories)
    )
    return snapshot && entry ? this.listingFromEntry(source, snapshot, entry) : null
  }

  private async performRefresh(sourceId: string): Promise<PluginMarketplaceSourceState> {
    const source = (await this.teamPolicy.list(this.store)).find(
      (candidate) => candidate.id === sourceId
    )
    if (!source) {
      throw new Error(`unknown marketplace source: ${sourceId}`)
    }
    try {
      const snapshot = await this.refreshSnapshot(source)
      this.sourceErrors.delete(source.id)
      return pluginMarketplaceSourceState(source, snapshot, undefined, this.teamPolicy)
    } catch (error) {
      const cached = await this.store.readSnapshot(source.id).catch(() => null)
      const message = pluginMarketplaceErrorMessage(error)
      this.sourceErrors.set(source.id, message)
      if (!cached) {
        throw error
      }
      return pluginMarketplaceSourceState(source, cached, message, this.teamPolicy)
    }
  }

  private async performOfficialSeed(): Promise<PluginMarketplaceSourceState> {
    const sources = await this.store.listSources()
    const existing = sources.find(({ source }) => this.teamPolicy.isDefaultOfficialSource(source))
    const source =
      existing ?? (await this.store.addSource(OFFICIAL_MARKETPLACE_GIT_SOURCE, Date.now()))
    const snapshot = await this.store.readSnapshot(source.id).catch(() => null)
    if (snapshot) {
      return pluginMarketplaceSourceState(source, snapshot, undefined, this.teamPolicy)
    }
    try {
      return await this.refreshSource(source.id)
    } catch (error) {
      // Keep official source configuration offline so later refreshes need no user-supplied URL.
      const message = pluginMarketplaceErrorMessage(error)
      this.sourceErrors.set(source.id, message)
      return pluginMarketplaceSourceState(source, null, message, this.teamPolicy)
    }
  }

  private async waitForOfficialSeed(): Promise<void> {
    await this.officialSeedPromise?.catch(() => undefined)
    await this.communitySeed.settled()
  }

  private async refreshSnapshot(
    source: PluginMarketplaceRegisteredSource,
    register: () =>
      | PluginMarketplaceRegisteredSource
      | Promise<PluginMarketplaceRegisteredSource> = () => source
  ): Promise<PluginMarketplaceCachedSnapshot> {
    const save = async (
      fetched: PluginMarketplaceFetchResult,
      catalogRepository?: CatalogRepositorySlot
    ) => {
      validateMarketplaceProvenance(source, fetched)
      return this.store.writeSnapshot({ source: await register(), ...fetched, catalogRepository })
    }
    if (this.fetcher) {
      return save(await this.fetcher(source))
    }
    await this.repositorySweep
    const published = await this.store.readSnapshot(source.id).catch(() => null)
    return fetchPluginMarketplace(source, { repositories: this.repositories!, published }, save)
  }

  private listingFromEntry(
    source: PluginMarketplaceRegisteredSource,
    snapshot: PluginMarketplaceCachedSnapshot,
    entry: PluginMarketplaceEntry
  ): PluginMarketplaceListing | null {
    return pluginMarketplaceListing({
      source,
      snapshot,
      entry,
      hostVersion: this.hostVersion,
      blocked: this.getKillListEntry(entry.id),
      requiredRules: this.teamPolicy.requiredPluginRules(),
      managedByTeams: this.teamPolicy.managedByTeams(source.source)
    })
  }
}
