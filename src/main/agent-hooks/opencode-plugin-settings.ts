import type { PluginSources } from '../../wsl-guest/plugin-overlay'
import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import type { ManagedHookDetectionSettings } from './managed-hook-detection-commands'

function enabled(settings: ManagedHookDetectionSettings, agent: 'opencode' | 'opencode2'): boolean {
  return isAgentStatusHooksEnabledForAgent(settings, agent)
}

export function openCodePluginSettingsKey(settings: ManagedHookDetectionSettings): string {
  return `${enabled(settings, 'opencode')}:${enabled(settings, 'opencode2')}`
}

export function selectOpenCodePluginSources(
  sources: PluginSources,
  settings: ManagedHookDetectionSettings
): PluginSources {
  // Older relays retain omitted sources; an empty string replaces the cache and cannot write a plugin.
  return {
    ...sources,
    opencodePluginSource: enabled(settings, 'opencode') ? sources.opencodePluginSource : '',
    opencode2PluginSource: enabled(settings, 'opencode2') ? sources.opencode2PluginSource : ''
  }
}
