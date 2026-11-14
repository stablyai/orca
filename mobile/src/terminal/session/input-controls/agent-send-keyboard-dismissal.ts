import type { AgentStatusEntry } from '../../../../../src/shared/agent-status/contracts/agent-status-types'
import type { TuiAgent } from '../../../../../src/shared/agent-launch/catalog/tui-agent'
import { isMobileTerminalTabRunningAgent } from '../../../session/tabs/mobile-terminal-tab-agent'

export type AgentSendKeyboardDismissalTab = {
  readonly type: string
  readonly title: string
  readonly agentStatus?: {
    readonly agentType?: AgentStatusEntry['agentType'] | null
    readonly state?: AgentStatusEntry['state']
  } | null
  readonly launchAgent?: TuiAgent | null
}

// Agent sends hand over the turn, so reveal the reply; shell commands keep the keyboard for command bursts.
export function shouldDismissKeyboardAfterTerminalSend(
  tab: AgentSendKeyboardDismissalTab | null | undefined,
  accepted: boolean
): boolean {
  if (!accepted || !tab || tab.type !== 'terminal') {
    return false
  }
  return isMobileTerminalTabRunningAgent(tab)
}
