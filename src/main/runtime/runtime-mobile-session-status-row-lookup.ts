import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

/** A pane's status rows, then those joined only through its terminal handle; indexed once, on first use. */
export function createRuntimeMobileSessionStatusRowLookup(
  getStatusSnapshot: () => AgentStatusIpcPayload[]
): (paneKey: string, terminalHandle: string | null) => AgentStatusIpcPayload[] {
  let statusRowsByPaneKey: Map<string, AgentStatusIpcPayload[]> | null = null
  let statusRowsByTerminalHandle: Map<string, AgentStatusIpcPayload[]> | null = null
  return (paneKey, terminalHandle) => {
    if (!statusRowsByPaneKey || !statusRowsByTerminalHandle) {
      statusRowsByPaneKey = new Map()
      statusRowsByTerminalHandle = new Map()
      for (const row of getStatusSnapshot()) {
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
