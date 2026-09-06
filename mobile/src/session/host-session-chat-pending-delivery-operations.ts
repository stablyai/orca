import type { MobileSessionChatPendingDelivery } from '../storage/mobile-session-chat-pending-deliveries'

export type HostSessionChatPendingDeliveryOperations = {
  load: (
    workspaceId: string,
    tabId: string,
    sessionId: string
  ) => Promise<MobileSessionChatPendingDelivery[]>
  save: (
    workspaceId: string,
    tabId: string,
    sessionId: string,
    deliveries: readonly MobileSessionChatPendingDelivery[]
  ) => Promise<void>
}
