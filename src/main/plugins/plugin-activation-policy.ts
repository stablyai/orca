import {
  getPluginActivationState,
  type PluginActivationState,
  type PluginConsentLists
} from '../../shared/plugins/approval/plugin-consent-state'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginServiceOptions } from './plugin-service-options'

export function snapshotPluginConsentLists(source: {
  getPluginConsents: () => Record<string, string>
  getDisabledPlugins: () => string[]
}): PluginConsentLists {
  return {
    pluginConsents: source.getPluginConsents(),
    disabledPlugins: source.getDisabledPlugins()
  }
}

export function isPluginApproved(
  enabled: boolean,
  plugin: ValidDiscoveredPlugin,
  lists: PluginConsentLists
): boolean {
  return (
    enabled &&
    getPluginActivationState(plugin.pluginKey, plugin.consentFingerprint, lists) === 'approved'
  )
}

/** The settings every plugin policy decision reads. */
export type PluginPolicySource = Pick<
  PluginServiceOptions,
  'isPluginSystemEnabled' | 'getPluginConsents' | 'getDisabledPlugins' | 'getPluginKillListEntry'
>

/** Live consent state. The feature flag is an authority boundary, not only a discovery hint:
 *  callers fail closed immediately even before async reconciliation ends. */
export function livePluginActivationState(
  source: PluginPolicySource,
  plugin: ValidDiscoveredPlugin
): PluginActivationState {
  if (!source.isPluginSystemEnabled()) {
    return 'disabled'
  }
  return getPluginActivationState(
    plugin.pluginKey,
    plugin.consentFingerprint,
    snapshotPluginConsentLists(source)
  )
}

/** Why the plugin may not run despite consent: Orca's safety list. Full access needs only consent. */
export function pluginPolicyBlockError(
  source: PluginPolicySource,
  pluginKey: string
): string | null {
  const blocked = source.getPluginKillListEntry?.(pluginKey)
  return blocked ? `Blocked by Orca's plugin safety list: ${blocked.reason}` : null
}
