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

/** Inverts one agent-status snapshot to pane key by provider session id, so a projection can put a
 *  chat tab — whose own id (`agent-session:<sessionId>`) is no pane key — back on the pane its agent
 *  runs in. A session two panes both claim is ambiguous and drops out, as does a row naming only
 *  one of the two. */
export function indexPaneKeysByProviderSessionId(
  rows: readonly AgentStatusIpcPayload[]
): Map<string, string> {
  const paneKeyBySessionId = new Map<string, string>()
  const ambiguousSessionIds = new Set<string>()
  for (const row of rows) {
    const sessionId = row.providerSession?.id
    if (!sessionId || !row.paneKey) {
      continue
    }
    const known = paneKeyBySessionId.get(sessionId)
    if (known === undefined) {
      paneKeyBySessionId.set(sessionId, row.paneKey)
    } else if (known !== row.paneKey) {
      ambiguousSessionIds.add(sessionId)
    }
  }
  for (const sessionId of ambiguousSessionIds) {
    paneKeyBySessionId.delete(sessionId)
  }
  return paneKeyBySessionId
}
