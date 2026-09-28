import type { PluginSources } from '../../relay/plugin-overlay'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { isAgentStatusHooksEnabled } from './managed-agent-hook-controls'
import type { ManagedHookDetectionSettings } from './managed-hook-detection-commands'

function enabled(settings: ManagedHookDetectionSettings, agent: 'opencode' | 'opencode2'): boolean {
  return (
    isAgentStatusHooksEnabled(settings) && isTuiAgentEnabled(agent, settings?.disabledTuiAgents)
  )
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
