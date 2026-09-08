import {
  MobileWebWorkspaceChangeSchema,
  type MobileWebWorkspaceChange
} from '../../shared/mobile-web/workspace-presentation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeSubscription } from './mobile-web-bridge-subscription'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'

export function subscribeMobileWebHostWorkspace(
  subscriptions: MobileWebBridgeSubscriptionClient,
  onEvent: (event: MobileWebWorkspaceChange) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscription {
  return subscriptions.subscribeHost(
    { method: 'mobileWeb.workspace.subscribe', params: {} },
    (event) => {
      const change = MobileWebWorkspaceChangeSchema.safeParse(
        typeof event === 'object' && event !== null && 'type' in event
          ? { type: event.type }
          : undefined
      )
      if (!change.success) {
        onError(new MobileWebBridgeClientError('invalid_message', false))
        return
      }
      onEvent(change.data)
    },
    onError
  )
}
