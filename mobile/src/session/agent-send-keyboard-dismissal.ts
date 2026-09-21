import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { isClaudeManagementTitle } from '../../../src/shared/agent-title-core'
import { isShellProcess } from '../../../src/shared/shell-process-detection'
import { resolveMobileTerminalTabOwnedAgentId } from './mobile-terminal-tab-agent'

/** Minimal session-tab shape needed to tell an agent session from a plain shell. */
export type AgentSendKeyboardDismissalTab = {
  readonly type: string
  readonly title: string
  readonly agentStatus?: {
    readonly agentType?: AgentStatusEntry['agentType'] | null
    readonly state?: AgentStatusEntry['state']
  } | null
  readonly launchAgent?: TuiAgent | null
}

/** Whether a send from this tab should drop the software keyboard.
 *
 *  Why: sending to an agent hands the turn over, and the keyboard hides the
 *  reply the user is now waiting on. A plain shell keeps it — commands come in
 *  bursts, and re-opening the keyboard between each one costs more than the
 *  covered rows. `launchAgent` counts before the first agent-status update
 *  lands, so the very first accepted prompt of a session already dismisses. */
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
