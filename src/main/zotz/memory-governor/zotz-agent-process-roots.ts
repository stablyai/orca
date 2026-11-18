import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { collectSubtree, enumerateProcesses } from '../../memory/collector'
import { listRegisteredPtys } from '../../memory/pty-registry'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { ZotzLiveAgentPane } from './zotz-agent-memory-sampler'

/** A live agent and the process its tree hangs from: a terminal's shell or a native chat's provider. */
export type ZotzAgentProcessRoot = ZotzLiveAgentPane & { pid: number }

const STRUCTURED_TAB_PREFIX = structuredAgentSessionTabId('')

/** Native chats have no PTY; their provider process is the owner recorded on the session lease. */
function structuredSessionPid(row: AgentStatusIpcPayload): number | null {
  if (row.structuredHost !== 'owned' || !row.tabId?.startsWith(STRUCTURED_TAB_PREFIX)) {
    return null
  }
  const sessionId = row.tabId.slice(STRUCTURED_TAB_PREFIX.length)
  const lease = getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)?.lease
  return lease?.claimStatus === 'live' ? (lease.ownerProcess?.pid ?? null) : null
}

/** Agents this host runs: hook-reported terminals with a live local PTY, and native chats it owns. */
export function listZotzAgentProcessRoots(
  statusRows: readonly AgentStatusIpcPayload[]
): ZotzAgentProcessRoot[] {
  const ptyPidByPane = new Map<string, number>()
  for (const pty of listRegisteredPtys()) {
    if (pty.paneKey && pty.pid != null) {
      ptyPidByPane.set(pty.paneKey, pty.pid)
    }
  }
  const roots = new Map<string, ZotzAgentProcessRoot>()
  for (const row of statusRows) {
    if (row.providerSessionOnly || !isTuiAgent(row.agentType)) {
      continue
    }
    const pid = ptyPidByPane.get(row.paneKey) ?? structuredSessionPid(row)
    if (pid == null) {
      continue
    }
    roots.set(row.paneKey, {
      paneKey: row.paneKey,
      agent: row.agentType,
      state: row.state,
      worktreeId: row.worktreeId ?? null,
      pid
    })
  }
  return [...roots.values()]
}

/** Each root's whole process tree, enumerated once; a process shared by two trees counts once. */
export async function measureZotzAgentProcessRoots(
  roots: readonly ZotzAgentProcessRoot[]
): Promise<Map<string, number>> {
  const index = await enumerateProcesses()
  const claimed = new Set<number>()
  const byPane = new Map<string, number>()
  for (const root of roots) {
    let bytes = 0
    for (const pid of collectSubtree(index, root.pid, claimed)) {
      claimed.add(pid)
      bytes += index.byPid.get(pid)?.memory ?? 0
    }
    byPane.set(root.paneKey, bytes)
  }
  return byPane
}
