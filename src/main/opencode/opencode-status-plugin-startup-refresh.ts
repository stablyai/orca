import { isAgentStatusHooksEnabledForAgent } from '../../shared/agent-status-hooks-setting'
import type { ManagedHookDetectionSettings } from '../agent-hooks/managed-hook-detection-commands'
import { openCode2HookService, openCodeHookService } from './hook-service'

// Why: an Orca upgrade must reach an OpenCode 2 service that is already running, which reloads a
// changed plugin file, instead of waiting for the next pane spawn to rewrite it.
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
