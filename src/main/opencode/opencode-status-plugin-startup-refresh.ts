import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import type { ManagedHookDetectionSettings } from '../agent-hooks/managed-hook-detection-commands'
import { openCode2HookService, openCodeHookService } from './hook-service'

// Refresh running OpenCode 2 services on upgrade without waiting for a pane to rewrite the plugin.
export function refreshInstalledOpenCodeStatusPlugins(
  settings: ManagedHookDetectionSettings
): void {
  if (isAgentStatusHooksEnabledForAgent(settings, 'opencode')) {
    openCodeHookService.refreshInstalledPlugins()
  }
  if (isAgentStatusHooksEnabledForAgent(settings, 'opencode2')) {
    openCode2HookService.refreshInstalledPlugins()
  }
}
