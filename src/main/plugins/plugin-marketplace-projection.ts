import type {
  PluginMarketplaceEntry,
  PluginMarketplaceGitSource
} from '../../shared/plugins/plugin-marketplace'
import type { PluginCatalogRelease } from '../../shared/plugins/plugin-catalog-release'

export type PluginMarketplaceSourceState = {
  id: string
  source: PluginMarketplaceGitSource
  addedAt: number
  marketplace: {
    name: string
    owner: string
    resolvedCommit: string
    fetchedAt: number
  } | null
  stale: boolean
  official: boolean
  error?: string
}

export type PluginMarketplaceListing = {
  marketplaceSourceId: string
  marketplaceName: string
  marketplaceOwner: string
  marketplaceCommit: string
  pluginKey: string
  source: PluginMarketplaceEntry['source']
  description?: string
  categories: string[]
  official: boolean
  bundled: boolean
  blockedByKillList?: { reason: string; advisoryUrl?: string }
  /** Exact release the catalog vouches for; absent for v1 catalogs. */
  release?: PluginCatalogRelease
}
