export function isTerminalSubscribedResult(
  value: unknown
): value is { type: 'subscribed'; streamId: number } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'subscribed' &&
    typeof (value as { streamId?: unknown }).streamId === 'number'
  )
}

export function isStreamingSubscriptionReadyResult(
  value: unknown
): value is { type: 'ready'; subscriptionId: string } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'ready' &&
    typeof (value as { subscriptionId?: unknown }).subscriptionId === 'string'
  )
}

export function consumeFirstStreamControlResponse(
  stream: { sent?: 'awaiting' | 'received' } | undefined
): boolean {
  if (stream?.sent !== 'awaiting') {
    return false
  }
  stream.sent = 'received'
  return true
}
