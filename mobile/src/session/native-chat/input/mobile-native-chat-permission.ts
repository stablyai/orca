import type { ChatApproval } from '../../../../../src/shared/native-chat-interactive-prompt'

export type MobileChatPermission = ChatApproval & {
  /** Structured prompt identity, present only when the host can cancel it exactly. */
  prompt?: { itemId: string; expectedRevision: number }
}
