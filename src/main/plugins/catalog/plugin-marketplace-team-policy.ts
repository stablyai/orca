import type { OrcaCloudCapabilities } from '../../../shared/orca-profiles/orca-cloud-capabilities'
import {
  ORCA_CLOUD_TEAM_POLICY_FLAGS as flags,
  type RequiredPluginRule
} from '../../../shared/orca-profiles/orca-cloud-team-policy'
import {
  isOfficialMarketplaceGitSource,
  isSameGitRepository,
  OFFICIAL_MARKETPLACE_GIT_SOURCE,
  type PluginMarketplaceGitSource
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from '../../../shared/plugins/catalog/plugin-install-link'
import {
  marketplaceSourceId,
  type PluginMarketplaceRegisteredSource,
  type PluginMarketplaceStore
} from './plugin-marketplace-store'

type CatalogSource = Pick<PluginMarketplaceGitSource, 'url' | 'ref'>

export function isOfficialPluginChannel(source: CatalogSource): boolean {
  return (
    source.ref === OFFICIAL_MARKETPLACE_GIT_SOURCE.ref && isOfficialMarketplaceGitSource(source.url)
  )
}

export function isCommunityPluginChannel(source: CatalogSource): boolean {
  return (
    source.ref === COMMUNITY_MARKETPLACE_GIT_SOURCE.ref &&
    isSameGitRepository(source.url, COMMUNITY_MARKETPLACE_GIT_SOURCE.url)
  )
}

export function allowsTeamCatalogSource(
  source: CatalogSource,
  capabilities: OrcaCloudCapabilities | undefined
): boolean {
  if (capabilities?.flags[flags.plugins] === false) {
    return false
  }
  if (
    capabilities?.teamPolicy?.internalCatalogs?.some(
      (catalog) => catalog.url === source.url && catalog.ref === source.ref
    )
  ) {
    return true
  }
  if (isOfficialPluginChannel(source)) {
    return capabilities?.flags[flags.officialPlugins] !== false
  }
  if (isCommunityPluginChannel(source)) {
    return capabilities?.flags[flags.communityPlugins] !== false
  }
  return capabilities?.flags[flags.allowMemberSources] !== false
}

export class PluginMarketplaceTeamPolicy {
  constructor(private readonly getCapabilities?: () => OrcaCloudCapabilities | undefined) {}

  allows(source: PluginMarketplaceGitSource, capabilities = this.getCapabilities?.()): boolean {
    return allowsTeamCatalogSource(source, capabilities)
  }

  requiredPluginRules(): readonly RequiredPluginRule[] | undefined {
    return this.getCapabilities?.()?.teamPolicy?.requiredPluginRules
  }

  isManaged(sourceId: string, capabilities = this.getCapabilities?.()): boolean {
    return (
      capabilities?.teamPolicy?.internalCatalogs?.some(
        (source) => marketplaceSourceId(source) === sourceId
      ) ?? false
    )
  }

  async list(store: PluginMarketplaceStore): Promise<PluginMarketplaceRegisteredSource[]> {
    const capabilities = this.getCapabilities?.()
    const sources = await store.listSources()
    if (!capabilities) {
      return [...sources]
    }
    const visible = sources.filter(({ source }) => this.allows(source, capabilities))
    const visibleIds = new Set(visible.map(({ id }) => id))
    for (const source of capabilities.teamPolicy?.internalCatalogs ?? []) {
      const id = marketplaceSourceId(source)
      if (!visibleIds.has(id) && this.allows(source, capabilities)) {
        visibleIds.add(id)
        visible.push({ id, source, addedAt: capabilities.refreshedAt })
      }
    }
    return visible
  }
}
