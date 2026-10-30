import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isClaudeManagementTitle } from '../../../src/shared/agent-title-core'
import { isShellProcess } from '../../../src/shared/shell-process-detection'
import { resolveMobileTerminalTabOwnedAgentId } from './mobile-terminal-tab-agent'

export type AgentSendKeyboardDismissalTab = {
  readonly type: string
  readonly title: string
  readonly agentStatus?: {
    readonly agentType?: AgentStatusEntry['agentType'] | null
    readonly state?: AgentStatusEntry['state']
  } | null
  readonly launchAgent?: TuiAgent | null
}

// Agent sends hand over the turn, so reveal the reply; shell commands keep the keyboard for command bursts. Count launch hints before status arrives.
export function shouldDismissKeyboardAfterTerminalSend(
  tab: AgentSendKeyboardDismissalTab | null | undefined,
  accepted: boolean
): boolean {
  if (!accepted || !tab || tab.type !== 'terminal') {
    return false
  }
  if (
    tab.agentStatus?.state === 'done' &&
    (isShellProcess(tab.title) || isClaudeManagementTitle(tab.title))
  ) {
    return false
  }
  return resolveMobileTerminalTabOwnedAgentId(tab) !== null
}
