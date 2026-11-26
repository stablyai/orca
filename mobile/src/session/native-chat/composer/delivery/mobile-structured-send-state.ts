import type { AgentJournalCursor } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../src/shared/agent-session/view/structured-agent-session-message-projection'
import type { MobileNativeChatSendErrorReporter } from './use-mobile-native-chat-send-error'
import type { MobileStructuredSendConfirmation } from './mobile-structured-send-recorded-read'

export type MobileStructuredSends = {
  optimistic: readonly StructuredAgentSessionOptimisticMessage[]
  imagePreviewsByMessageId: Record<string, string[]>
  accept: (send: StructuredAgentSessionOptimisticMessage, images?: string[]) => void
  acknowledge: (clientMessageId: string, cursor?: AgentJournalCursor) => void
  reject: (clientMessageId: string) => void
  holdUnconfirmed: (clientMessageId: string, onUnconfirmed: () => void) => void
}

export type MobileStructuredSendStateArgs = {
  sessionKey: string
  sessionId?: string | null
  connected?: boolean
  cursor?: AgentJournalCursor | null
  submissions: readonly AgentJournalSubmission[]
  queuedMessages: readonly AgentSessionQueuedMessage[] | null
  onSendError: MobileNativeChatSendErrorReporter
  /** Asks the host whether it recorded a send; null when a lookup is unavailable. */
  confirmRecorded: MobileStructuredSendConfirmation | null
  draftScope?: string | null
}
