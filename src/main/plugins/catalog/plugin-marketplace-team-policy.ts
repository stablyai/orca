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
    const internal = capabilities?.teamPolicy?.internalCatalog
    return (
      capabilities?.flags[flags.communityPlugins] !== false ||
      (internal !== undefined && marketplaceSourceId(source) === marketplaceSourceId(internal))
    )
  }

  managedSourceId(): string | undefined {
    const source = this.getCapabilities?.()?.teamPolicy?.internalCatalog
    return source && marketplaceSourceId(source)
  }

  async list(store: PluginMarketplaceStore): Promise<PluginMarketplaceRegisteredSource[]> {
    const capabilities = this.getCapabilities?.()
    const sources = await store.listSources()
    if (!capabilities) {
      return [...sources]
    }
    const visible = sources.filter(({ source }) => this.allows(source, capabilities))
    const internal = capabilities.teamPolicy?.internalCatalog
    if (internal && this.allows(internal, capabilities)) {
      const id = marketplaceSourceId(internal)
      if (!visible.some((source) => source.id === id)) {
        visible.push({ id, source: internal, addedAt: capabilities.refreshedAt })
      }
    }
    return visible
  }
}
