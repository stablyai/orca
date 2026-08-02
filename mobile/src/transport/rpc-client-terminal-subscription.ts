import { buildNativeChatUnsubscribe } from '../../../src/shared/native-chat-stream-unsubscribe'

type TerminalStreamParams = {
  terminal?: unknown
}

type MutableStreamRequest = {
  method: string
  params: unknown
}

export function updateTerminalSubscriptionViewport(
  streams: Iterable<MutableStreamRequest>,
  terminal: string,
  viewport: { cols: number; rows: number }
): void {
  for (const stream of streams) {
    if (
      stream.method !== 'terminal.subscribe' ||
      !stream.params ||
      typeof stream.params !== 'object'
    ) {
      continue
    }
    const params = stream.params as TerminalStreamParams
    if (params.terminal !== terminal) {
      continue
    }
    stream.params = {
      ...stream.params,
      viewport
    }
  }
}

/** Build the unsubscribe RPC for a streaming method that needs the host told to
 *  tear down (session tabs, native chat), or null when none is required. Keeps
 *  the per-method echo logic out of the rpc-client teardown closure. */
export function buildStreamUnsubscribe(
  method: string | undefined,
  params: unknown
): { method: string; params: Record<string, unknown> } | null {
  if (!params || typeof params !== 'object') {
    return null
  }
  if (method === 'session.tabs.subscribe') {
    const worktree = (params as { worktree?: unknown }).worktree
    return typeof worktree === 'string'
      ? { method: 'session.tabs.unsubscribe', params: { worktree } }
      : null
  }
  if (method === 'nativeChat.subscribe') {
    const subscriptionId = (params as { subscriptionId?: unknown }).subscriptionId
    if (typeof subscriptionId === 'string') {
      return { method: 'nativeChat.unsubscribe', params: { subscriptionId } }
    }
    // Backward compatibility for callers that predate explicit cleanup tokens.
    const agent = (params as { agent?: unknown }).agent
    const sessionId = (params as { sessionId?: unknown }).sessionId
    return typeof agent === 'string' && typeof sessionId === 'string'
      ? buildNativeChatUnsubscribe(agent, sessionId)
      : null
  }
  return null
}

export function buildTerminalUnsubscribeParams(
  params: unknown
): { subscriptionId: string; client?: { id: string } } | null {
  if (!params || typeof params !== 'object') {
    return null
  }
  const subscribeParams = params as {
    terminal?: unknown
    client?: { id?: unknown }
  }
  if (typeof subscribeParams.terminal !== 'string') {
    return null
  }
  const clientId =
    typeof subscribeParams.client?.id === 'string' ? subscribeParams.client.id : undefined
  return {
    subscriptionId: clientId ? `${subscribeParams.terminal}:${clientId}` : subscribeParams.terminal,
    ...(clientId ? { client: { id: clientId } } : {})
  }
}
