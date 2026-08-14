import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { MobileStructuredOutboxEntry } from './mobile-structured-outbox-store'
import type { MobileStructuredSessionMutations } from './use-mobile-structured-session-mutations'

export type MobileStructuredSessionWrites = MobileStructuredSessionMutations & {
  outbox: MobileStructuredOutboxEntry[]
  hydrated: boolean
  error: string | null
  send: (text: string, attachments?: readonly PendingNativeChatImage[]) => Promise<boolean>
  takeQueuedForEdit: (clientMessageId: string) => Promise<MobileStructuredOutboxEntry | null>
  retry: (clientMessageId: string) => Promise<void>
}
