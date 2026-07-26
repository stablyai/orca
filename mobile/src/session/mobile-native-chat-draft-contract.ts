export type MobileNativeChatPendingMessage = {
  id: string
  text: string
  expectedOccurrence: number
  images?: string[]
  baselineTailMessageId: string | null
}

export type MobileNativeChatSendOrigin = {
  draftKey: string
  pendingKey: string | null
  normalizedText: string
  baselineOccurrences: number
  baselineTailMessageId: string | null
  draftEditRevision: number
}

export const NO_PENDING_MESSAGES: MobileNativeChatPendingMessage[] = []
export const UNCONFIRMED_SEND_DEADLINE_MS = 20_000
