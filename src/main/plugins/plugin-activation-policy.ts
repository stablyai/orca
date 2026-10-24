import {
  getPluginActivationState,
  type PluginActivationState,
  type PluginConsentLists
} from '../../shared/plugins/approval/plugin-consent-state'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginServiceOptions } from './plugin-service-options'
import { pluginExecutionProfile } from '../../shared/plugins/plugin-execution-profile'

export const PLUGIN_FULL_ACCESS_OFF_ERROR =
  'Full access plugins are turned off. Turn on "Allow full-access plugins" in Plugin settings.'

/** Why a second gate: trusted workers are unsandboxed Node, so the system switch alone is not enough. */
export function isFullAccessBlocked(
  plugin: Pick<ValidDiscoveredPlugin, 'manifest'>,
  isFullAccessAllowed: () => boolean
): boolean {
  return pluginExecutionProfile(plugin.manifest) === 'trusted-worker' && !isFullAccessAllowed()
}

export function fullAccessError(
  plugin: Pick<ValidDiscoveredPlugin, 'manifest'> | null,
  isFullAccessAllowed: () => boolean
): string | null {
  return plugin && isFullAccessBlocked(plugin, isFullAccessAllowed)
    ? PLUGIN_FULL_ACCESS_OFF_ERROR
    : null
}

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
  | 'isPluginSystemEnabled'
  | 'isFullAccessAllowed'
  | 'getPluginConsents'
  | 'getDisabledPlugins'
  | 'getPluginKillListEntry'
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

/** Why the plugin may not run despite consent: the safety list, then the full-access switch. */
export function pluginPolicyBlockError(
  source: PluginPolicySource,
  pluginKey: string,
  plugin: Pick<ValidDiscoveredPlugin, 'manifest'> | null
): string | null {
  const blocked = source.getPluginKillListEntry?.(pluginKey)
  return blocked
    ? `Blocked by Orca's plugin safety list: ${blocked.reason}`
    : fullAccessError(plugin, source.isFullAccessAllowed)
}
