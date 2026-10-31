import type { PluginInstallSource } from '../../../shared/plugins/installation/plugin-install-lockfile'
import {
  isOfficialMarketplaceGitSource,
  isOfficialOrganizationGitSource,
  hasOfficialPluginPublisher,
  isReservedPluginIdentity
} from '../../../shared/plugins/catalog/plugin-marketplace'

export function pluginInstallTrustError(
  pluginKey: string,
  source: PluginInstallSource
): string | null {
  if (source.kind === 'bundled') {
    return source.bundleId === pluginKey && hasOfficialPluginPublisher(pluginKey)
      ? null
      : 'bundled plugins must use the official stablyai publisher'
  }
  if (!isReservedPluginIdentity(pluginKey)) {
    return null
  }
  // Why the catalog and not the repository: a direct Git URL or another catalog could point
  // at any stablyai repository, including one never meant to ship.
  return source.kind === 'marketplace' &&
    isOfficialMarketplaceGitSource(source.marketplace.url) &&
    isOfficialOrganizationGitSource(source.plugin.url)
    ? null
    : `${pluginKey} uses a name reserved for official Orca plugins; Orca installs it only from its official catalog`
}
