import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

/** Groups one agent-status snapshot by pane key so a projection that resolves many
 *  panes reads the snapshot once instead of rescanning (and re-materializing) it per
 *  pane. Rows without a pane key are unaddressable here and dropped. */
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
