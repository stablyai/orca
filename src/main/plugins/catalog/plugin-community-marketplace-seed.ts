import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from '../../../shared/plugins/catalog/plugin-install-link'
import {
  isSameGitRepository,
  type PluginMarketplaceGitSource
} from '../../../shared/plugins/catalog/plugin-marketplace'
import type { PluginMarketplaceStore } from './plugin-marketplace-store'

// Why throttled: listings wait on an in-flight seed, so an offline retry must not stall every view.
const COMMUNITY_SEED_RETRY_MS = 10 * 60 * 1000

/**
 * Adds the community catalog once, so Orca shows it by default. It stays non-official, so its
 * plugins keep the publisher notice and install review; a user who removes it keeps it removed.
 */
export class CommunityMarketplaceSeed {
  private inFlight: Promise<void> | null = null
  private failedAt: number | null = null

  constructor(
    private readonly store: Pick<
      PluginMarketplaceStore,
      'hasSeededDefault' | 'markDefaultSeeded' | 'listSources'
    >,
    private readonly addSource: (source: PluginMarketplaceGitSource) => Promise<unknown>
  ) {}

  run(now = Date.now()): Promise<void> {
    if (this.inFlight) {
      return this.inFlight
    }
    if (this.failedAt !== null && now - this.failedAt < COMMUNITY_SEED_RETRY_MS) {
      return Promise.resolve()
    }
    const seed = this.perform()
      .then(() => {
        this.failedAt = null
      })
      .catch((error: unknown) => {
        this.failedAt = now
        throw error
      })
      .finally(() => {
        if (this.inFlight === seed) {
          this.inFlight = null
        }
      })
    this.inFlight = seed
    return seed
  }

  /** Settles when a running seed does, so the first view after it already lists the catalog. */
  async settled(): Promise<void> {
    await this.inFlight?.catch(() => undefined)
  }

  private async perform(): Promise<void> {
    if (await this.store.hasSeededDefault('community')) {
      return
    }
    const sources = await this.store.listSources()
    const present = sources.some((source) =>
      isSameGitRepository(source.source.url, COMMUNITY_MARKETPLACE_GIT_SOURCE.url)
    )
    if (!present) {
      await this.addSource(COMMUNITY_MARKETPLACE_GIT_SOURCE)
    }
    await this.store.markDefaultSeeded('community')
  }
}
