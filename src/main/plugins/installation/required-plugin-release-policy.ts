import { satisfies } from 'semver'
import type { PluginMarketplaceGitSource } from '../../../shared/plugins/catalog/plugin-marketplace'
import {
  isCommunityPluginChannel,
  isOfficialPluginChannel
} from '../catalog/plugin-marketplace-team-policy'
import type { PluginLockEntry } from '../../../shared/plugins/installation/plugin-install-lockfile'
import type { RequiredPluginRule } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import { getActiveTeamCapabilities } from '../../orca-profiles/cloud-auth/active-team-capabilities'

export function requiredPluginReleaseAllowed(
  rules: readonly RequiredPluginRule[] | undefined,
  pluginKey: string,
  version: string,
  source: Pick<PluginMarketplaceGitSource, 'url' | 'ref'> | undefined
): boolean {
  return (
    rules?.every(
      (rule) =>
        rule.pluginKey !== pluginKey ||
        (source !== undefined &&
          satisfies(version, rule.version) &&
          matchesCatalog(rule.catalog, source))
    ) ?? true
  )
}

function matchesCatalog(
  catalog: RequiredPluginRule['catalog'],
  source: Pick<PluginMarketplaceGitSource, 'url' | 'ref'>
): boolean {
  switch (catalog) {
    case 'official':
      return isOfficialPluginChannel(source)
    case 'community':
      return isCommunityPluginChannel(source)
    default:
      return catalog.url === source.url && catalog.ref === source.ref
  }
}

export function requiredPluginInstallError(
  entry: Pick<PluginLockEntry, 'pluginKey' | 'version' | 'source'>,
  rules = getActiveTeamCapabilities()?.teamPolicy?.requiredPluginRules
): string | null {
  const source = entry.source.kind === 'marketplace' ? entry.source.marketplace : undefined
  return requiredPluginReleaseAllowed(rules, entry.pluginKey, entry.version, source)
    ? null
    : 'Your team requires a different catalog or version for this plugin.'
}
