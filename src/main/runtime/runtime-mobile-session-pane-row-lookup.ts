import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { indexAgentStatusRowsByPaneKey } from '../agent-hooks/agent-status-pane-index'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'

export function createHookRowsForPaneLookup(
  host: Pick<
    RuntimeMobileSessionProjectionHost,
    'getProviderSessionRows' | 'getProviderSessionSnapshot'
  >
): (paneKey: string) => AgentStatusIpcPayload[] {
  // Production reads hook rows by pane; the snapshot fallback remains for tests
  // and embedders that have not adopted the narrow getter.
  let hookRowsByPaneKey: Map<string, AgentStatusIpcPayload[]> | null = null
  const hookRowsForPane = new Map<string, AgentStatusIpcPayload[]>()
  return (paneKey: string): AgentStatusIpcPayload[] => {
    const cached = hookRowsForPane.get(paneKey)
    if (cached) {
      return cached
    }
    const direct = host.getProviderSessionRows(paneKey)
    if (direct) {
      hookRowsForPane.set(paneKey, direct)
      return direct
    }
    hookRowsByPaneKey ??= indexAgentStatusRowsByPaneKey(host.getProviderSessionSnapshot())
    const rows = hookRowsByPaneKey.get(paneKey) ?? []
    hookRowsForPane.set(paneKey, rows)
    return rows
  }
}

export function createStatusRowsLookup(
  host: Pick<RuntimeMobileSessionProjectionHost, 'getStatusSnapshot'>
): (paneKey: string, terminalHandle: string | null) => AgentStatusIpcPayload[] {
  let statusRowsByPaneKey: Map<string, AgentStatusIpcPayload[]> | null = null
  let statusRowsByTerminalHandle: Map<string, AgentStatusIpcPayload[]> | null = null
  return (paneKey: string, terminalHandle: string | null): AgentStatusIpcPayload[] => {
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
