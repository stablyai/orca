import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'

export async function closeStructuredAgentSessionForClient(
  host: StructuredAgentSessionHost,
  sessionId: string
): Promise<{ ok: true }> {
  // Start shutdown before bookkeeping, so a failed or pending write cannot delay it.
  const [closed, hidden] = await Promise.allSettled([
    host.close(sessionId, 'user-close'),
    (async () => {
      // Terminal-disposal closes use this RPC without the session-tabs retirement RPC.
      if (typeof host.setSessionTabVisibility === 'function') {
        await host.setSessionTabVisibility(sessionId, false)
      }
    })()
  ])
  if (hidden.status === 'rejected') {
    host.deps.logger.warn('hiding a closed chat tab failed', {
      scope: 'tab-close-visibility',
      sessionId,
      error: hidden.reason
    })
  }
  if (closed.status === 'rejected') {
    throw closed.reason
  }
  if (hidden.status === 'rejected') {
    throw hidden.reason
  }
  return { ok: true }
}
