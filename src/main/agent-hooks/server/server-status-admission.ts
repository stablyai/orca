import {
  canAdmitLegacyAgentStatusEntry,
  type HookListenerState
} from '../../../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status-legacy-adapter'

export function canWriteHookServerLegacyStatusRow(
  state: HookListenerState,
  entry: AgentHookEventPayload
): boolean {
  return canAdmitLegacyAgentStatusEntry(
    state,
    'main-status-update',
    entry,
    AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
  )
}
