import type {
  MobileWebNativeChatEvent,
  MobileWebNativeChatSubscribePayload
} from '../../shared/mobile-web/native-chat-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeSubscription } from './mobile-web-bridge-subscription'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'

export type MobileWebNativeChatSubscriptionArgs = [
  payload: MobileWebNativeChatSubscribePayload,
  onEvent: (event: MobileWebNativeChatEvent) => void,
  onError: (error: MobileWebBridgeClientError) => void
]

export function subscribeMobileWebHostNativeChat(
  subscriptions: MobileWebBridgeSubscriptionClient,
  tabId: string,
  ...[payload, onEvent, onError]: MobileWebNativeChatSubscriptionArgs
): MobileWebBridgeSubscription {
  let cancelled = false
  let current: MobileWebBridgeSubscription | undefined
  const ready = (async () => {
    if (cancelled) {
      throw new MobileWebBridgeClientError('cancelled', false)
    }
    current = subscriptions.subscribeHost(
      {
        method: 'mobileWeb.nativeChat.subscribe',
        workspaceId: payload.workspaceId,
        params: {
          tabId,
          sessionId: payload.sessionId,
          read: { limit: payload.limit, capabilities: { transcriptPending: 1 } }
        }
      },
      (event) => {
        if (cancelled) {
          return
        }
        if (typeof event !== 'object' || event === null || !('type' in event)) {
          onError(new MobileWebBridgeClientError('invalid_message', false))
          return
        }
        if (event.type !== 'ready') {
          onEvent(event as MobileWebNativeChatEvent)
        }
      },
      onError
    )
    await current.ready
  })()
  void ready.catch((error: unknown) => {
    if (!cancelled && !current) {
      onError(
        error instanceof MobileWebBridgeClientError
          ? error
          : new MobileWebBridgeClientError('unavailable', true)
      )
    }
  })
  return {
    ready,
    unsubscribe() {
      cancelled = true
      current?.unsubscribe()
    }
  }
}
