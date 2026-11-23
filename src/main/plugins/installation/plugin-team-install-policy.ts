import { ORCA_CLOUD_TEAM_POLICY_FLAGS as flags } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import { allowsTeamCatalogSource } from '../catalog/plugin-marketplace-team-policy'
import type {
  PluginBlockNotice,
  PluginKillListEntry
} from '../../../shared/plugins/catalog/plugin-kill-list'
import type { PluginInstallSource } from '../../../shared/plugins/installation/plugin-install-lockfile'
import { getActiveTeamCapabilities } from '../../orca-profiles/cloud-auth/active-team-capabilities'

function teamAllowsMemberPluginSource(): boolean {
  const capabilities = getActiveTeamCapabilities()
  return (
    capabilities?.flags[flags.plugins] !== false &&
    capabilities?.flags[flags.allowMemberSources] !== false
  )
}

export function assertTeamAllowsUncatalogedPlugin(): void {
  if (!teamAllowsMemberPluginSource()) {
    throw new Error('Your team manages which plugin catalogs you can install from.')
  }
}

export function teamAllowsPluginInstallSource(source: PluginInstallSource): boolean {
  switch (source.kind) {
    case 'bundled':
      return true
    case 'marketplace':
      return allowsTeamCatalogSource(source.marketplace, getActiveTeamCapabilities())
    default:
      return teamAllowsMemberPluginSource()
  }
}

export function findTeamPluginBlock(
  pluginKey: string
): (PluginKillListEntry & PluginBlockNotice) | null {
  return getActiveTeamCapabilities()?.teamPolicy?.blockedPlugins?.includes(pluginKey)
    ? { pluginKey, team: true, reason: 'Blocked by your team.' }
    : null
}

export function getRequiredTeamPlugins(): readonly string[] | undefined {
  const capabilities = getActiveTeamCapabilities()
  return capabilities?.flags[flags.plugins] !== false
    ? capabilities?.teamPolicy?.requiredPlugins
    : undefined
}

export function assertPluginIsNotRequired(pluginKey: string): void {
  if (getRequiredTeamPlugins()?.includes(pluginKey)) {
    throw new Error('This plugin is required by your team.')
  }
}
