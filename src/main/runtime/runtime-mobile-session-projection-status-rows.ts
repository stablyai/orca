import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { indexAgentStatusRowsByPaneKey } from '../agent-hooks/agent-status-pane-index'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'

/** Index status rows once, then serve the pane/terminal union used by one projection pass. */
export function createStatusRowsReader(
  host: RuntimeMobileSessionProjectionHost
): (paneKey: string, terminalHandle: string | null) => AgentStatusIpcPayload[] {
  let statusRowsByPaneKey: Map<string, AgentStatusIpcPayload[]> | null = null
  let statusRowsByTerminalHandle: Map<string, AgentStatusIpcPayload[]> | null = null
  return (paneKey, terminalHandle) => {
    if (!statusRowsByPaneKey || !statusRowsByTerminalHandle) {
      statusRowsByPaneKey = new Map()
      statusRowsByTerminalHandle = new Map()
      for (const row of host.getStatusSnapshot()) {
        const paneRows = statusRowsByPaneKey.get(row.paneKey)
        if (paneRows) {
          paneRows.push(row)
        } else {
          statusRowsByPaneKey.set(row.paneKey, [row])
        }
        if (row.terminalHandle) {
          const handleRows = statusRowsByTerminalHandle.get(row.terminalHandle)
          if (handleRows) {
            handleRows.push(row)
          } else {
            statusRowsByTerminalHandle.set(row.terminalHandle, [row])
          }
        }
      }
    }
    const paneRows = statusRowsByPaneKey.get(paneKey) ?? []
    if (!terminalHandle) {
      return paneRows
    }
    const handleRows = statusRowsByTerminalHandle.get(terminalHandle) ?? []
    if (paneRows.length === 0) {
      return handleRows
    }
    return [...paneRows, ...handleRows.filter((row) => !paneRows.includes(row))]
  }
}

export function createProviderSessionRowsReader(
  host: RuntimeMobileSessionProjectionHost
): (paneKey: string) => AgentStatusIpcPayload[] {
  let snapshotIndex: Map<string, AgentStatusIpcPayload[]> | null = null
  const cache = new Map<string, AgentStatusIpcPayload[]>()
  return (paneKey) => {
    const cached = cache.get(paneKey)
    if (cached) {
      return cached
    }
    const direct = host.getProviderSessionRows(paneKey)
    if (direct) {
      cache.set(paneKey, direct)
      return direct
    }
    snapshotIndex ??= indexAgentStatusRowsByPaneKey(host.getProviderSessionSnapshot())
    const rows = snapshotIndex.get(paneKey) ?? []
    cache.set(paneKey, rows)
    return rows
  }
}
