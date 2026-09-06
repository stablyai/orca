export function mobileWebOperationKey(request: { capability: string; operation: string }): string {
  return `${request.capability}.${request.operation}`
}

export function mobileWebRequestExpectsSubscription(request: {
  capability: string
  operation: string
}): boolean {
  return (
    (request.capability === 'workspace' ||
      request.capability === 'account' ||
      request.capability === 'session' ||
      request.capability === 'sourceControl' ||
      request.capability === 'terminal' ||
      request.capability === 'browser' ||
      request.capability === 'nativeChat' ||
      request.capability === 'speech') &&
    request.operation === 'subscribe'
  )
}

export function mobileWebWorkspaceSnapshotContinuation(request: {
  capability: string
  operation: string
  payload: unknown
}): boolean {
  return (
    request.capability === 'workspace' &&
    request.operation === 'snapshot' &&
    typeof request.payload === 'object' &&
    request.payload !== null &&
    'cursor' in request.payload &&
    typeof request.payload.cursor === 'string'
  )
}

export function mobileWebAgentHistoryContinuation(request: {
  capability: string
  operation: string
  payload: unknown
}): boolean {
  return (
    request.capability === 'agentHistory' &&
    request.operation === 'snapshot' &&
    typeof request.payload === 'object' &&
    request.payload !== null &&
    'cursor' in request.payload &&
    typeof request.payload.cursor === 'string'
  )
}

export function mobileWebEncodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export function mobileWebPendingForOperation(
  pending: Iterable<{ operationKey: string }>,
  operationKey: string
): number {
  let count = 0
  for (const request of pending) {
    if (request.operationKey === operationKey) {
      count += 1
    }
  }
  return count
}

export function mobileWebPendingRequestForSubscription(
  pending: Iterable<[string, { subscriptionId?: string }]>,
  subscriptionId: string
): string | null {
  for (const [requestId, request] of pending) {
    if (request.subscriptionId === subscriptionId) {
      return requestId
    }
  }
  return null
}
