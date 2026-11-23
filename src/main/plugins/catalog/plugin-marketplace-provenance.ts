import {
  OFFICIAL_MARKETPLACE_OWNER,
  isOfficialMarketplaceGitSource,
  isOfficialOrganizationGitSource,
  isReservedPluginIdentity
} from '../../../shared/plugins/catalog/plugin-marketplace'
import type { PluginMarketplaceFetchResult } from './plugin-marketplace-fetch'
import type { PluginMarketplaceRegisteredSource } from './plugin-marketplace-store'

export function validateMarketplaceProvenance(
  source: PluginMarketplaceRegisteredSource,
  fetched: PluginMarketplaceFetchResult
): void {
  const official = isOfficialMarketplaceGitSource(source.source.url)
  if (official && fetched.marketplace.owner.toLowerCase() !== OFFICIAL_MARKETPLACE_OWNER) {
    throw new Error('official marketplace metadata has an unexpected owner')
  }
  for (const entry of fetched.marketplace.plugins) {
    if (!isReservedPluginIdentity(entry.id)) {
      continue
    }
    if (!official) {
      throw new Error(
        `${entry.id} uses a name reserved for official Orca plugins; only Orca's official catalog may list it`
      )
    }
    if (!isOfficialOrganizationGitSource(entry.source.url)) {
      throw new Error(
        `reserved plugin identity ${entry.id} must resolve to the stablyai organization`
      )
    }
  }
}
