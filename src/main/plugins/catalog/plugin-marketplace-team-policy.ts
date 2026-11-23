import type { OrcaCloudCapabilities } from '../../../shared/orca-profiles/orca-cloud-capabilities'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS as flags } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import {
  isOfficialMarketplaceGitSource,
  type PluginMarketplaceGitSource
} from '../../../shared/plugins/catalog/plugin-marketplace'
import {
  marketplaceSourceId,
  type PluginMarketplaceRegisteredSource,
  type PluginMarketplaceStore
} from './plugin-marketplace-store'

export class PluginMarketplaceTeamPolicy {
  constructor(private readonly getCapabilities?: () => OrcaCloudCapabilities | undefined) {}

  allows(source: PluginMarketplaceGitSource, capabilities = this.getCapabilities?.()): boolean {
    if (capabilities?.flags[flags.plugins] === false) {
      return false
    }
    if (isOfficialMarketplaceGitSource(source.url)) {
      return capabilities?.flags[flags.officialPlugins] !== false
    }
    return (
      capabilities?.flags[flags.communityPlugins] !== false ||
      this.isManaged(marketplaceSourceId(source), capabilities)
    )
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
