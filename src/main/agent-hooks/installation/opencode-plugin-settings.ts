import type { PluginSources } from '../../../wsl-guest/plugins/installation/plugin-sources'
import { isAgentStatusHooksEnabledForAgent } from '../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import type { ManagedHookDetectionSettings } from './managed-hook-detection-commands'

function enabled(settings: ManagedHookDetectionSettings, agent: 'opencode' | 'opencode2'): boolean {
  return isAgentStatusHooksEnabledForAgent(settings, agent)
}

export function openCodePluginSettingsKey(settings: ManagedHookDetectionSettings): string {
  // Granted agents too: a new approval must let the WSL relay's next pass install without waiting out its throttle.
  const granted = Object.entries(settings?.agentHookConsent ?? {})
    .filter(([, decision]) => decision === 'granted')
    .map(([agent]) => agent)
    .sort()
    .join(',')
  return `${enabled(settings, 'opencode')}:${enabled(settings, 'opencode2')}:${isAgentStatusHooksEnabledForAgent(settings, 'claude') && settings?.claudeSubagentNavigationEnabled !== false}:${granted}`
}

export function selectOpenCodePluginSources(
  sources: PluginSources,
  settings: ManagedHookDetectionSettings
): PluginSources {
  // Older relays retain omitted sources; an empty string replaces the cache and cannot write a plugin.
  return {
    ...sources,
    claudeAgentViewSource:
      isAgentStatusHooksEnabledForAgent(settings, 'claude') &&
      settings?.claudeSubagentNavigationEnabled !== false
        ? sources.claudeAgentViewSource
        : '',
    opencodePluginSource: enabled(settings, 'opencode') ? sources.opencodePluginSource : '',
    opencode2PluginSource: enabled(settings, 'opencode2') ? sources.opencode2PluginSource : ''
  }
}
