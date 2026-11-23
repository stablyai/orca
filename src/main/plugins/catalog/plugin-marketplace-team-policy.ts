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

function sameCatalog(left: CatalogSource, right: CatalogSource): boolean {
  return left.url === right.url && left.ref === right.ref
}

function findInternalCatalog(
  source: CatalogSource,
  capabilities: OrcaCloudCapabilities | undefined
) {
  return capabilities?.teamPolicy?.internalCatalogs?.find((catalog) => sameCatalog(catalog, source))
}

export function isOfficialPluginChannel(source: CatalogSource): boolean {
  return (
    source.ref === OFFICIAL_MARKETPLACE_GIT_SOURCE.ref && isOfficialMarketplaceGitSource(source.url)
  )
}

export function getCatalogManagingTeams(
  source: CatalogSource,
  capabilities: OrcaCloudCapabilities | undefined
): string[] | undefined {
  if (!findInternalCatalog(source, capabilities)) {
    return undefined
  }
  return (
    capabilities?.teamPolicy?.internalCatalogAttribution?.find(({ catalog }) =>
      sameCatalog(catalog, source)
    )?.teamNames ?? []
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
  if (findInternalCatalog(source, capabilities)) {
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
  private capabilities: OrcaCloudCapabilities | undefined
  private managedSources = new Map<string, PluginMarketplaceRegisteredSource>()

  constructor(private readonly getCapabilities?: () => OrcaCloudCapabilities | undefined) {}

  allows(source: PluginMarketplaceGitSource, capabilities = this.getCapabilities?.()): boolean {
    return allowsTeamCatalogSource(source, capabilities)
  }

  requiredPluginRules(): readonly RequiredPluginRule[] | undefined {
    return this.getCapabilities?.()?.teamPolicy?.requiredPluginRules
  }

  isDefaultOfficialSource(source: CatalogSource): boolean {
    return this.getCapabilities?.()
      ? isOfficialPluginChannel(source)
      : isOfficialMarketplaceGitSource(source.url)
  }

  managedByTeams(source: CatalogSource): string[] | undefined {
    return getCatalogManagingTeams(source, this.getCapabilities?.())
  }

  isManaged(sourceId: string, capabilities = this.getCapabilities?.()): boolean {
    return (
      capabilities?.teamPolicy?.internalCatalogs?.some(
        (source) => marketplaceSourceId(source) === sourceId
      ) ?? false
    )
  }

  configuredManagedSourceIds(): Iterable<string> {
    return this.managed(this.getCapabilities?.()).keys()
  }

  findEffectiveSource(
    store: Pick<PluginMarketplaceStore, 'registeredSource'>,
    sourceId: string
  ): PluginMarketplaceRegisteredSource | undefined {
    const capabilities = this.getCapabilities?.()
    const managed = this.managed(capabilities)
    const source = store.registeredSource(sourceId) ?? managed.get(sourceId)
    return source && this.allows(source.source, capabilities) ? source : undefined
  }

  async loadEffectiveSource(store: PluginMarketplaceStore, sourceId: string) {
    await store.listSources()
    return this.findEffectiveSource(store, sourceId)
  }

  async list(store: PluginMarketplaceStore): Promise<PluginMarketplaceRegisteredSource[]> {
    const sources = await store.listSources()
    const capabilities = this.getCapabilities?.()
    if (!capabilities) {
      return [...sources]
    }
    const visible = sources.filter(({ source }) => this.allows(source, capabilities))
    const visibleIds = new Set(visible.map(({ id }) => id))
    for (const managed of this.managed(capabilities).values()) {
      if (!visibleIds.has(managed.id) && this.allows(managed.source, capabilities)) {
        visible.push(managed)
      }
    }
    return visible
  }

  private managed(capabilities: OrcaCloudCapabilities | undefined) {
    if (this.capabilities !== capabilities) {
      const next = new Map<string, PluginMarketplaceRegisteredSource>()
      for (const source of capabilities?.teamPolicy?.internalCatalogs ?? []) {
        const id = marketplaceSourceId(source)
        next.set(
          id,
          this.managedSources.get(id) ?? { id, source, addedAt: capabilities!.refreshedAt }
        )
      }
      this.managedSources = next
      this.capabilities = capabilities
    }
    return this.managedSources
  }
}
