import { agentHookServer } from '../agent-hooks/server/agent-hook-server'
import type { AgentPromptChannel } from './orchestration/mailbox/terminal-pointer/mailbox-pointer-channel-submit'
import type { OrchestrationMailboxTerminal } from './orchestration/mailbox/routing/mailbox-owner'

/** The prompt channel of the Claude running in this terminal, when Orca's plugin in it is polling. */
export function claudeTerminalPromptChannel(
  terminal: Pick<OrchestrationMailboxTerminal, 'paneKeys'> | null
): AgentPromptChannel | null {
  const mail = agentHookServer.claudeTerminalMail
  const paneKey = terminal?.paneKeys.find((key) => mail.isLive(key))
  return paneKey ? (text) => mail.submit(paneKey, text) : null
}
