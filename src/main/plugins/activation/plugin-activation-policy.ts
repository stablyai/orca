import {
  getPluginActivationState,
  type PluginActivationState,
  type PluginConsentLists
} from '../../../shared/plugins/approval/plugin-consent-state'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'
import type { PluginServiceOptions } from '../plugin-service-options'
import { isRequiredTeamPluginInstall } from '../installation/plugin-team-install-policy'
import { requiredPluginInstallError } from '../installation/required-plugin-release-policy'

export function installedPluginReleasePolicyError(plugin: ValidDiscoveredPlugin): string | null {
  // Development folders keep their own consent when they shadow an installed release.
  return plugin.isDev
    ? null
    : requiredPluginInstallError(
        plugin.teamPolicyInstall ?? {
          pluginKey: plugin.pluginKey,
          version: plugin.manifest.version
        }
      )
}

export function snapshotPluginConsentLists(
  source: Pick<
    PluginServiceOptions,
    'getPluginConsents' | 'getDisabledPlugins' | 'getRequiredPlugins'
  >
): PluginConsentLists {
  const required = source.getRequiredPlugins?.()
  return {
    pluginConsents: source.getPluginConsents(),
    disabledPlugins: source.getDisabledPlugins(),
    ...(required?.length ? { requiredPlugins: required } : {})
  }
}

export function isPluginApproved(
  enabled: boolean,
  plugin: ValidDiscoveredPlugin,
  lists: PluginConsentLists
): boolean {
  return enabled && installedPluginActivationState(plugin, lists) === 'approved'
}

function installedPluginActivationState(
  plugin: ValidDiscoveredPlugin,
  lists: PluginConsentLists
): PluginActivationState {
  if (installedPluginReleasePolicyError(plugin)) {
    return 'disabled'
  }
  return getPluginActivationState(
    plugin.pluginKey,
    plugin.consentFingerprint,
    lists,
    isRequiredTeamPluginInstall(plugin.teamPolicyInstall)
  )
}

/** The settings every plugin policy decision reads. */
export type PluginPolicySource = Pick<
  PluginServiceOptions,
  | 'isPluginSystemEnabled'
  | 'getPluginConsents'
  | 'getDisabledPlugins'
  | 'getPluginKillListEntry'
  | 'getRequiredPlugins'
>

/** Live consent state. The feature flag is an authority boundary, not only a discovery hint:
 *  callers fail closed immediately even before async reconciliation ends. */
export function livePluginActivationState(
  source: PluginPolicySource,
  plugin: ValidDiscoveredPlugin
): PluginActivationState {
  if (!source.isPluginSystemEnabled() || source.getPluginKillListEntry?.(plugin.pluginKey)) {
    return 'disabled'
  }
  return installedPluginActivationState(plugin, snapshotPluginConsentLists(source))
}

/** Why the plugin may not run despite consent: Orca's safety list. Full access needs only consent. */
export function pluginPolicyBlockError(
  source: PluginPolicySource,
  pluginKey: string
): string | null {
  const blocked = source.getPluginKillListEntry?.(pluginKey)
  if (!blocked) {
    return null
  }
  return blocked.team ? blocked.reason : `Blocked by Orca's plugin safety list: ${blocked.reason}`
}
