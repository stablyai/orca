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

/** Live consent state. The feature flag is an authority boundary, not only a discovery hint:
 *  callers fail closed immediately even before async reconciliation ends. */
export function livePluginActivationState(
  source: Pick<
    PluginServiceOptions,
    'isPluginSystemEnabled' | 'getPluginConsents' | 'getDisabledPlugins'
  >,
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
