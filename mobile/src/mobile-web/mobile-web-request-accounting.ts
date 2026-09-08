import {
  MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS,
  MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS
} from '../../../src/shared/mobile-web/bridge-limits'
import { MOBILE_WEB_BRIDGE_OPERATIONS } from '../../../src/shared/mobile-web/bridge-operation-registry'
export function mobileWebOperationKey(request: { capability: string; operation: string }): string {
  return `${request.capability}.${request.operation}`
}

export function mobileWebRequestExpectsSubscription(request: {
  capability: string
  operation: string
}): boolean {
  return (
    (request.capability === 'workspace' && request.operation === 'hostSubscribe') ||
    ((request.capability === 'terminal' || request.capability === 'speech') &&
      request.operation === 'subscribe')
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

// Native alerts outlive client churn and explicit cancels; the OS dialog owns the resolution.
export function mobileWebRequestSurvivesCancellation(pending: { operationKey: string }): boolean {
  return pending.operationKey === 'native.alert'
}

export function mobileWebSubscriptionCount(
  pending: Iterable<{ subscriptionId?: string }>,
  ledgers: readonly { countForOperation: (key: string) => number }[]
): number {
  let count = Array.from(pending).filter((entry) => entry.subscriptionId !== undefined).length
  for (const [capability, operations] of Object.entries(MOBILE_WEB_BRIDGE_OPERATIONS)) {
    for (const [operation, kind] of Object.entries(operations)) {
      if (kind === 'subscription') {
        for (const ledger of ledgers) {
          count += ledger.countForOperation(`${capability}.${operation}`)
        }
      }
    }
  }
  return count
}

export function mobileWebRequestAtCapacity(args: {
  pending: ReadonlyMap<string, { operationKey: string; subscriptionId?: string }>
  request: { mode: 'once' | 'subscription'; capability: string; operation: string }
  ledgers: readonly { countForOperation: (key: string) => number }[]
  isHostRequest: boolean
  hostRequestsInFlight: number
  maxConcurrent: number
}): boolean {
  const key = mobileWebOperationKey(args.request)
  return (
    (args.isHostRequest && args.hostRequestsInFlight >= args.maxConcurrent) ||
    args.pending.size >= MOBILE_WEB_BRIDGE_MAX_PENDING_REQUESTS ||
    (args.request.mode === 'subscription' &&
      mobileWebSubscriptionCount(args.pending.values(), args.ledgers) >=
        MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS) ||
    mobileWebPendingForOperation(args.pending.values(), key) +
      args.ledgers.reduce((sum, ledger) => sum + ledger.countForOperation(key), 0) >=
      args.maxConcurrent
  )
}

// Only one-shot forwards hold host work past a page cancellation; subscriptions are capped by
// their own ledger.
export function mobileWebIsHostRequest(request: {
  capability: string
  operation: string
}): boolean {
  return request.capability === 'workspace' && request.operation === 'hostRequest'
}
