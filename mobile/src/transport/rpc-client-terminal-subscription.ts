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

// Why: resolves a terminal handle to its live binary streamId from the rpc
// client's per-connection routing maps, so callers never track raw streamIds.
export function findRoutableTerminalStreamId(
  streams: ReadonlyMap<string, MutableStreamRequest>,
  terminalStreamIdsByRequest: ReadonlyMap<string, ReadonlySet<number>>,
  routableStreamIds: ReadonlyMap<number, unknown>,
  terminal: string
): number | null {
  for (const [requestId, streamIds] of terminalStreamIdsByRequest) {
    const stream = streams.get(requestId)
    if (
      !stream ||
      stream.method !== 'terminal.subscribe' ||
      !stream.params ||
      typeof stream.params !== 'object' ||
      (stream.params as TerminalStreamParams).terminal !== terminal
    ) {
      continue
    }
    // Why: a request can accumulate ids across host-side resubscribes; the
    // latest still-routable one is the live stream.
    let latest: number | null = null
    for (const streamId of streamIds) {
      if (routableStreamIds.has(streamId)) {
        latest = streamId
      }
    }
    if (latest !== null) {
      return latest
    }
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
