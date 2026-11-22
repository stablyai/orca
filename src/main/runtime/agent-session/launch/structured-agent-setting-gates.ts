import { isAgentStatusHooksEnabledForAgent } from '../../../../shared/agent-hook-listener/configuration/agent-status-hooks-setting'
import { preModeChatGetsFullAccess } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { StructuredAgentSessionRuntimeDeps } from '../installation/structured-agent-session-runtime-contract'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { nativeChatShowsPromptSuggestions } from '../../../../shared/native-chat/settings/native-chat-appearance-settings'

/** Per-agent chat gates read from this host's current settings. */
export function structuredAgentSettingGates(
  readStore: () => RuntimeStore
): Pick<
  StructuredAgentSessionRuntimeDeps,
  | 'resolveAgentFullAccess'
  | 'piManagedExtensionsEnabled'
  | 'nativeChatPromptSuggestions'
  | 'transientRecovery'
> {
  const getSettings = () => readStore().getSettings()
  return {
    resolveAgentFullAccess: (agent) =>
      isTuiAgent(agent) && preModeChatGetsFullAccess(agent, getSettings(), process.platform),
    piManagedExtensionsEnabled: () => isAgentStatusHooksEnabledForAgent(getSettings(), 'pi'),
    nativeChatPromptSuggestions: () => nativeChatShowsPromptSuggestions(getSettings()),
    transientRecovery: {
      enabled: () => getSettings().nativeChatAutoContinueOnTransientError === true,
      onDisabled: (listener) =>
        readStore().onSettingsChanged?.((updates) => {
          if (updates.nativeChatAutoContinueOnTransientError === false) {
            listener()
          }
        }) ?? (() => {})
    }
  }
}
