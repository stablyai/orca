import type { HostSessionChatPendingDeliveryOperations } from './host-session-chat-pending-delivery-operations'
import {
  loadMobileSessionChatPendingDeliveries,
  saveMobileSessionChatPendingDeliveries
} from '../storage/mobile-session-chat-pending-deliveries'

const NATIVE_MOBILE_BUILD_IDENTITY = 'native-mobile-v1'

export function nativeHostSessionChatPendingDeliveryOperations(
  hostId: string
): HostSessionChatPendingDeliveryOperations {
  return {
    load(workspaceId, tabId, sessionId) {
      return loadMobileSessionChatPendingDeliveries({
        hostIdentity: hostId,
        buildIdentity: NATIVE_MOBILE_BUILD_IDENTITY,
        workspaceIdentity: workspaceId,
        tabIdentity: tabId,
        providerSessionIdentity: sessionId
      })
    },
    save(workspaceId, tabId, sessionId, deliveries) {
      return saveMobileSessionChatPendingDeliveries(
        {
          hostIdentity: hostId,
          buildIdentity: NATIVE_MOBILE_BUILD_IDENTITY,
          workspaceIdentity: workspaceId,
          tabIdentity: tabId,
          providerSessionIdentity: sessionId
        },
        deliveries
      )
    }
  }
}
