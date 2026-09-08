import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { HostSessionChatPendingDeliveryOperations } from './host-session-chat-pending-delivery-operations'

export function webHostSessionChatPendingDeliveryOperations(
  client: MobileWebBridgeClient
): HostSessionChatPendingDeliveryOperations {
  return {
    async load(workspaceId, _tabId, sessionId) {
      return (await client.nativeChat.pendingRead({ workspaceId, sessionId })).deliveries
    },
    async save(workspaceId, _tabId, sessionId, deliveries) {
      await client.nativeChat.pendingWrite({ workspaceId, sessionId, deliveries: [...deliveries] })
    }
  }
}
