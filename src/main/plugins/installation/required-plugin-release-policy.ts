import { satisfies } from 'semver'
import {
  isOfficialMarketplaceGitSource,
  isSameGitRepository,
  type PluginMarketplaceGitSource
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from '../../../shared/plugins/catalog/plugin-install-link'
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
      return isOfficialMarketplaceGitSource(source.url)
    case 'community':
      return isSameGitRepository(source.url, COMMUNITY_MARKETPLACE_GIT_SOURCE.url)
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
