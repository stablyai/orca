import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { nativeChatPreferenceFor } from '../../shared/structured-native-chat-launch-route'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../runtime/structured-agent-runtime-metadata'

export function hasChatUiLaunchTipEligibleHarness(settings: GlobalSettings): boolean {
  return STRUCTURED_AGENT_RUNTIME_METADATA.some(
    ({ definition, supportsLocation }) =>
      isTuiAgent(definition.agent) &&
      isTuiAgentEnabled(definition.agent, settings.disabledTuiAgents) &&
      !nativeChatPreferenceFor(settings, definition.agent) &&
      supportsLocation({
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: '',
        workspaceKind: 'folder'
      })
  )
}
