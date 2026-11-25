import type { DocumentDeliveryEndpoint } from '../../../../shared/backend/document-delivery-endpoint'
import type { SharedHostRoute } from '../requests/runtime-environment-shared-hosts'
import type { RetainedRemoteRuntimeSubscription } from './runtime-environment-subscription-setup'

/** A shared host's stream, kept like a paired server's: released by unsubscribe or with `document`. */
export async function subscribeSharedHostForDocument(
  subscriptions: Map<string, RetainedRemoteRuntimeSubscription>,
  document: DocumentDeliveryEndpoint,
  host: SharedHostRoute,
  subscriptionId: string,
  args: { selector: string; method: string; params?: unknown }
): Promise<{ subscriptionId: string; requestId: string }> {
  if (subscriptions.has(subscriptionId)) {
    throw new Error('Runtime environment subscription id already exists')
  }
  const lifetime = document.watchRetirement()
  let stop: (() => void) | null = null
  let closed = false
  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    lifetime.dispose()
    if (subscriptions.get(subscriptionId) === retained) {
      subscriptions.delete(subscriptionId)
    }
    stop?.()
  }
  const retained: RetainedRemoteRuntimeSubscription = {
    setupController: new AbortController(),
    requestId: subscriptionId,
    environmentId: args.selector,
    ownerWebContentsId: document.hostId,
    disposeRendererLifetime: () => lifetime.dispose(),
    // Its link's drops arrive as answers on the stream; it never closes on its own.
    notifyClosed: () => {},
    sendBinary: () => false,
    close
  }
  subscriptions.set(subscriptionId, retained)
  lifetime.signal.addEventListener('abort', close, { once: true })
  try {
    stop = await host.subscribe(args.method, args.params, (response) => {
      if (!closed && !document.isGone()) {
        document.send('runtimeEnvironments:subscriptionEvent', {
          subscriptionId,
          type: 'response',
          response
        })
      }
    })
  } catch (error) {
    close()
    throw error
  }
  // Released while the host was still answering: nothing is left to keep.
  if (closed) {
    stop()
  }
  return { subscriptionId, requestId: subscriptionId }
}
