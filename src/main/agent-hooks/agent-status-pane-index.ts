import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

/** Index once per snapshot to avoid rematerializing rows for every pane. */
export function indexAgentStatusRowsByPaneKey(
  rows: readonly AgentStatusIpcPayload[]
): Map<string, AgentStatusIpcPayload[]> {
  const byPaneKey = new Map<string, AgentStatusIpcPayload[]>()
  for (const row of rows) {
    if (!row.paneKey) {
      continue
    }
    const existing = byPaneKey.get(row.paneKey)
    if (existing) {
      existing.push(row)
      continue
    }
    byPaneKey.set(row.paneKey, [row])
  }
  return byPaneKey
}
