import type { HostSessionChatPendingDeliveryOperations } from './host-session-chat-pending-delivery-operations'
import { nativeHostSessionChatPendingDeliveryOperations } from './native-host-session-chat-pending-delivery-operations'

export function defaultHostSessionChatPendingDeliveryOperations(
  hostId: string
): HostSessionChatPendingDeliveryOperations {
  return nativeHostSessionChatPendingDeliveryOperations(hostId)
}
