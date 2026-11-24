import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'

/** A /clear continues a chat under a new session id; a Run names its coordinator by the first one. */
export function structuredSessionLineageRoot(sessionId: string): string {
  const store = getStructuredAgentSessionHost()?.deps.store
  let root = sessionId
  const seen = new Set([root])
  for (let predecessors = store?.listClearedFrom?.(root) ?? []; predecessors.length === 1;) {
    const [previous] = predecessors
    if (!previous || seen.has(previous)) {
      break
    }
    seen.add(previous)
    root = previous
    predecessors = store?.listClearedFrom?.(root) ?? []
  }
  return root
}
