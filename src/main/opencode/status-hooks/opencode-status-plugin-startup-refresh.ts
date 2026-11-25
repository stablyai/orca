import { isAppProfileRuntime } from '../../app-profiles/app-profile'
import { isAgentStatusHooksEnabledForAgent } from '../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import type { ManagedHookDetectionSettings } from '../../agent-hooks/installation/managed-hook-detection-commands'
import { openCode2HookService, openCodeHookService } from './hook-service'

// Refresh running OpenCode 2 services on upgrade without waiting for a pane to rewrite the plugin.
export function refreshInstalledOpenCodeStatusPlugins(
  settings: ManagedHookDetectionSettings
): void {
  // OpenCode keeps its folders in the real home, also in a profile; a profile changes none.
  if (isAppProfileRuntime()) {
    return
  }
  if (isAgentStatusHooksEnabledForAgent(settings, 'opencode')) {
    openCodeHookService.refreshInstalledPlugins()
  }
  if (isAgentStatusHooksEnabledForAgent(settings, 'opencode2')) {
    openCode2HookService.refreshInstalledPlugins()
  }
}
