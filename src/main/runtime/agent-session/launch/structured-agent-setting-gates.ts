import { isAgentStatusHooksEnabledForAgent } from '../../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import { preModeChatGetsFullAccess } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { StructuredAgentSessionRuntimeDeps } from '../installation/structured-agent-session-runtime-contract'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { nativeChatShowsPromptSuggestions } from '../../../../shared/native-chat/settings/native-chat-appearance-settings'

/** Per-agent chat gates read from this host's current settings. */
export function structuredAgentSettingGates(
  getSettings: () => ReturnType<RuntimeStore['getSettings']>
): Pick<
  StructuredAgentSessionRuntimeDeps,
  | 'resolveAgentFullAccess'
  | 'piManagedExtensionsEnabled'
  | 'nativeChatPromptSuggestions'
  | 'sharedCodexServers'
> {
  return {
    resolveAgentFullAccess: (agent) =>
      isTuiAgent(agent) && preModeChatGetsFullAccess(agent, getSettings(), process.platform),
    piManagedExtensionsEnabled: () => isAgentStatusHooksEnabledForAgent(getSettings(), 'pi'),
    nativeChatPromptSuggestions: () => nativeChatShowsPromptSuggestions(getSettings()),
    // Offered for this computer's chats only: a remote or WSL server runs plain Node, not Electron.
    sharedCodexServers: () =>
      process.versions.electron !== undefined &&
      getSettings().experimentalSharedCodexServers === true
  }
}
