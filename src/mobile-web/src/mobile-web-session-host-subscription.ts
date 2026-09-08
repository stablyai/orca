import {
  MobileWebSessionSnapshotResultSchema,
  type MobileWebSessionSnapshotResult,
  type MobileWebSessionSubscribePayload
} from '../../shared/mobile-web/session-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeSubscription } from './mobile-web-bridge-subscription'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'

export function subscribeHostSession(
  subscriptions: MobileWebBridgeSubscriptionClient,
  payload: MobileWebSessionSubscribePayload,
  onEvent: (snapshot: MobileWebSessionSnapshotResult) => void,
  onError: (error: MobileWebBridgeClientError) => void
) {
  let current: MobileWebBridgeSubscription | undefined
  let closed = false
  const fail = (error: MobileWebBridgeClientError) => {
    if (closed) {
      return
    }
    closed = true
    current?.unsubscribe()
    onError(error)
  }
  current = subscriptions.subscribeHost(
    {
      method: 'mobileWeb.session.subscribe',
      workspaceId: payload.workspaceId,
      params: { workspaceId: payload.workspaceId }
    },
    (event) => {
      if (closed) {
        return
      }
      if (typeof event !== 'object' || event === null || !('type' in event)) {
        fail(new MobileWebBridgeClientError('invalid_message', false))
        return
      }
      if (event.type === 'ready') {
        return
      }
      if (event.type === 'end' || event.type === 'error') {
        fail(new MobileWebBridgeClientError('unavailable', true))
        return
      }
      const result = MobileWebSessionSnapshotResultSchema.safeParse(
        'snapshot' in event ? event.snapshot : undefined
      )
      if (!result.success || result.data.workspaceId !== payload.workspaceId) {
        fail(new MobileWebBridgeClientError('invalid_message', false))
        return
      }
      onEvent(result.data)
    },
    fail
  )
  if (closed) {
    current.unsubscribe()
  }
  return {
    ready: current.ready,
    unsubscribe() {
      closed = true
      current?.unsubscribe()
    }
  }
}
