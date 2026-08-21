import {
  getPluginActivationState,
  type PluginConsentLists
} from '../../shared/plugins/plugin-consent-state'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

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
