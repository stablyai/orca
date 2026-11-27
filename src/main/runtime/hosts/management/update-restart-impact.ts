import type { RemoteServerUpdateRestartImpact } from '../../../../shared/remote-runtime/host-catalog/remote-server-update'
import { inProcessTerminalPtyIds } from '../../../ipc/pty/provider/kill-all'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** Names what an update restart would stop, using quit's own keep-or-stop rule. Reads memory only. */
export function readUpdateRestartImpact(): RemoteServerUpdateRestartImpact {
  return {
    chats: getStructuredAgentSessionHost()?.reads.agentsStoppedByQuit() ?? [],
    // Clients already hold terminal.list rows, so ids suffice; daemon terminals survive and aren't here.
    terminalPtyIds: inProcessTerminalPtyIds()
  }
}
