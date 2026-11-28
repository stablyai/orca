import { hasInProcessTerminalSessions } from '../../ipc/pty/provider/kill-all'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { hasPlainSshTerminalSessions } from '../../ssh/plain-ssh-terminal/plain-ssh-terminal-sessions'

/** Whether restarting for an automatic update would terminate live in-process terminals or native chats. */
export function hasAutomaticInstallBlockingWork(): boolean {
  return (
    hasInProcessTerminalSessions() ||
    hasPlainSshTerminalSessions() ||
    (getStructuredAgentSessionHost()?.reads.agentsStoppedByQuit().length ?? 0) > 0
  )
}
