import {
  MobileWebSourceControlSubscribePayloadSchema,
  type MobileWebSourceControlSubscribePayload,
  type MobileWebSourceControlStatusInvalidation
} from '../../shared/mobile-web/source-control-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'
import type { MobileWebBridgeSubscription } from './mobile-web-bridge-subscription'

export type MobileWebSourceControlSubscriptionArgs = [
  payload: MobileWebSourceControlSubscribePayload,
  onEvent: (event: MobileWebSourceControlStatusInvalidation) => void,
  onError: (error: MobileWebBridgeClientError) => void
]

export function subscribeHostSourceControl(
  subscriptions: MobileWebBridgeSubscriptionClient,
  ...[payload, onEvent, onError]: MobileWebSourceControlSubscriptionArgs
): MobileWebBridgeSubscription {
  if (!MobileWebSourceControlSubscribePayloadSchema.safeParse(payload).success) {
    const error = new MobileWebBridgeClientError('invalid_request', false)
    queueMicrotask(() => onError(error))
    return { ready: Promise.reject(error), unsubscribe() {} }
  }
  let cancelled = false
  const current: MobileWebBridgeSubscription = subscriptions.subscribeHost(
    {
      method: 'mobileWeb.files.watch',
      workspaceId: payload.workspaceId,
      params: {}
    },
    (event) => {
      if (cancelled || typeof event !== 'object' || event === null) {
        return
      }
      if ('type' in event && event.type === 'changed') {
        const events = 'events' in event && Array.isArray(event.events) ? event.events : null
        if (!events) {
          onError(new MobileWebBridgeClientError('invalid_message', false))
          return
        }
        const overflow =
          events.length > 5_000 ||
          events.some(
            (entry: unknown) =>
              typeof entry === 'object' &&
              entry !== null &&
              'kind' in entry &&
              entry.kind === 'overflow'
          )
        onEvent({ workspaceId: payload.workspaceId, reason: overflow ? 'overflow' : 'changed' })
      } else if ('type' in event && (event.type === 'error' || event.type === 'end')) {
        onError(new MobileWebBridgeClientError('unavailable', true))
      }
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
