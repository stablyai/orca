import type { RemoteServerUpdateRestartImpact } from '../../../../shared/remote-runtime/host-catalog/remote-server-update'
import { inProcessTerminalPtyIds } from '../../../ipc/pty/provider/kill-all'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'

// In-process terminals exist only when the daemon is unavailable, and then every terminal is one, so list them all.
const RESTART_IMPACT_TERMINAL_LIMIT = 10_000

/** Names what an update restart would stop, using quit's own keep-or-stop rule. */
export async function readUpdateRestartImpact(
  runtime: OrcaRuntimeService
): Promise<RemoteServerUpdateRestartImpact> {
  const chats = getStructuredAgentSessionHost()?.reads.agentsStoppedByQuit() ?? []
  const inProcessPtys = new Set(inProcessTerminalPtyIds())
  // Daemon terminals survive, so with no in-process PTY there is nothing to list.
  if (inProcessPtys.size === 0) {
    return { chats, terminals: [] }
  }
  const list = await runtime.listTerminals(undefined, RESTART_IMPACT_TERMINAL_LIMIT, {
    includeVisualLayouts: false,
    alternateScreenGridPreviews: false
  })
  const terminals = list.terminals.flatMap(({ preview: _preview, ...row }) =>
    row.ptyId && inProcessPtys.has(row.ptyId) ? [row] : []
  )
  return { chats, terminals }
}
