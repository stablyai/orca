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
