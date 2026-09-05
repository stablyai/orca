import type { RpcResponse } from './orca-rpc-wire'
import type { PendingRequestRegistry } from './orca-request-registry'

// Tracks active subscribe() calls by id and, once a stream starts, maps the server's numeric
// streamId back to its subscription so binary frames can be routed to the right onBinary callback.
export type Subscription = {
  id: string
  method: string
  params: unknown
  onData: (result: unknown) => void
  onBinary?: (payload: Uint8Array) => void
  cancelled: boolean
}

export class SubscriptionRegistry {
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly streamIdToSubscription = new Map<number, string>()

  add(subscription: Subscription): void {
    this.subscriptions.set(subscription.id, subscription)
  }

  get(id: string): Subscription | undefined {
    return this.subscriptions.get(id)
  }

  values(): IterableIterator<Subscription> {
    return this.subscriptions.values()
  }

  // Marks cancelled, removes it, and drops any streamId binding pointing at it.
  cancel(id: string): Subscription | undefined {
    const subscription = this.subscriptions.get(id)
    if (!subscription) {
      return undefined
    }
    subscription.cancelled = true
    this.subscriptions.delete(id)
    for (const [streamId, subId] of this.streamIdToSubscription) {
      if (subId === id) {
        this.streamIdToSubscription.delete(streamId)
      }
    }
    return subscription
  }

  bindStream(streamId: number, subscriptionId: string): void {
    this.streamIdToSubscription.set(streamId, subscriptionId)
  }

  bySubscriptionForStream(streamId: number): Subscription | undefined {
    const id = this.streamIdToSubscription.get(streamId)
    return id ? this.subscriptions.get(id) : undefined
  }
}

// Routes an authenticated RPC response to whichever registry owns its id: a streaming
// subscription (which also binds the streamId on first ack) or a one-shot pending request.
export function routeRpcResponse(
  response: RpcResponse,
  subscriptions: SubscriptionRegistry,
  pending: PendingRequestRegistry
): void {
  const subscription = subscriptions.get(response.id)
  if (subscription) {
    routeSubscriptionResponse(response, subscription, subscriptions)
    return
  }
  const request = pending.take(response.id)
  if (request) {
    clearTimeout(request.timer)
    request.resolve(response)
  }
}

function routeSubscriptionResponse(
  response: RpcResponse,
  subscription: Subscription,
  subscriptions: SubscriptionRegistry
): void {
  if (!response.ok) {
    subscription.onData({
      type: 'error',
      message: response.error.message,
      code: response.error.code
    })
    return
  }
  const result = response.result
  if (subscription.onBinary && isSubscribedResult(result)) {
    subscriptions.bindStream(result.streamId, subscription.id)
  }
  if (!subscription.cancelled) {
    subscription.onData(result)
  }
}

function isSubscribedResult(value: unknown): value is { type: 'subscribed'; streamId: number } {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'subscribed' &&
    typeof (value as { streamId?: unknown }).streamId === 'number'
  )
}
