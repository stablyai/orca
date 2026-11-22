import { ORCA_CLOUD_TEAM_POLICY_FLAGS as flags } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import { getActiveTeamCapabilities } from '../../orca-profiles/cloud-auth/active-team-capabilities'

export function assertTeamAllowsUncatalogedPlugin(): void {
  const capabilities = getActiveTeamCapabilities()
  if (
    capabilities?.flags[flags.plugins] === false ||
    capabilities?.flags[flags.communityPlugins] === false ||
    capabilities?.flags[flags.officialPlugins] === false
  ) {
    throw new Error('Your team manages which plugin catalogs you can install from.')
  }
}

export function assertPluginIsNotRequired(pluginKey: string): void {
  if (getActiveTeamCapabilities()?.teamPolicy?.requiredPlugins?.includes(pluginKey)) {
    throw new Error('This plugin is required by your team.')
  }
}
