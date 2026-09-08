import {
  MobileWebBrowserEventSchema,
  MobileWebBrowserStreamPayloadSchema,
  type MobileWebBrowserEvent,
  type MobileWebBrowserStreamPayload
} from '../../shared/mobile-web/browser-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeSubscription } from './mobile-web-bridge-subscription'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'

export type MobileWebBrowserSubscriptionArgs = [
  payload: MobileWebBrowserStreamPayload,
  onEvent: (event: MobileWebBrowserEvent) => void,
  onError: (error: MobileWebBridgeClientError) => void
]

export function subscribeMobileWebHostBrowser(
  subscriptions: MobileWebBridgeSubscriptionClient,
  ...[payload, onEvent, onError]: MobileWebBrowserSubscriptionArgs
): MobileWebBridgeSubscription {
  if (!MobileWebBrowserStreamPayloadSchema.safeParse(payload).success) {
    const error = new MobileWebBridgeClientError('invalid_request', false)
    queueMicrotask(() => onError(error))
    return { ready: Promise.reject(error), unsubscribe() {} }
  }
  const { workspaceId, pageId, ...request } = payload
  let cancelled = false
  const current = subscriptions.subscribeHost(
    {
      method: 'mobileWeb.browser.subscribe',
      workspaceId,
      params: { page: pageId, ...request }
    },
    (event) => {
      if (cancelled || isSubscriptionHandshake(event)) {
        return
      }
      const parsed = MobileWebBrowserEventSchema.safeParse(event)
      if (!parsed.success) {
        onError(new MobileWebBridgeClientError('invalid_message', false))
        return
      }
      onEvent(parsed.data)
    },
    (error) => {
      if (!cancelled) {
        onError(error)
      }
    }
  )
  return {
    ready: current.ready,
    unsubscribe() {
      cancelled = true
      current.unsubscribe()
    }
  }
}

/** The lane opens with a bare `ready` carrying the cancel id; the browser's own `ready` carries
 * tab state, which is what the pane waits for. */
function isSubscriptionHandshake(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'ready' &&
    !('tab' in event)
  )
}
