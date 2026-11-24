import { stripSentImagePromptMarkers } from '../../../../../../src/shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import type { AgentSessionFailureFact } from '../../../../../../src/shared/agent-session/failures/agent-session-failure'
import { mobileAgentSessionWriteNoticeText } from '../../agent-session/agent-session-write-notice-copy'
import type { AgentJournalSubmission } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage
} from '../../../../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
import {
  projectQueuedMessageCards,
  queuedMessageCardLine,
  queuedMessageCardNeedsAttention,
  queuedMessageReturnedNotice,
  type QueuedMessageCard
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-queued-cards'
// The shared projection decides each card's hold; this layer words it for the phone.

export type MobileQueuedMessageCard = QueuedMessageCard & {
  /** The text, or for a card of images alone, the image's name or their count. */
  line: string
  needsAttention: boolean
  // Leave plain waits uncaptioned; the question or queue-pause row already explains the hold.
  caption: string | null
}

function queuedMessageCardCaption(
  card: QueuedMessageCard,
  agentName: string | undefined,
  statedFailures: readonly AgentSessionFailureFact[]
): string | null {
  switch (card.hold) {
    case 'returned': {
      const notice = queuedMessageReturnedNotice(card, agentName, statedFailures)
      if (notice === null) {
        return null
      }
      return notice === 'withdrawn'
        ? 'Stopped before it was sent'
        : mobileAgentSessionWriteNoticeText(notice)
    }
    case 'paused':
      // Absent or unknown (newer host) marker: a plain pause, promising no release rule.
      if (card.pausedReason !== QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
        return 'Paused'
      }
      return card.waitsForAgent
        ? "Couldn't send — tap Send to retry once the agent finishes"
        : "Couldn't send — tap Send to retry"
    case 'sending':
    case 'turn':
    case 'queue-paused':
      return null
  }
}

export function mobileQueuedMessageCards(
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined,
  submissions: readonly AgentJournalSubmission[],
  facts: {
    agentWorking?: boolean
    queuePaused?: boolean
    agentName?: string
    statedFailures?: readonly AgentSessionFailureFact[]
    sending?: readonly QueuedMessageCard[]
    order?: readonly AgentSessionQueuedMessage[] | null
  } = {}
): MobileQueuedMessageCard[] {
  const cards = projectQueuedMessageCards(queuedMessages, submissions, facts)
  // Reorder preview changes positions without making a hidden handoff visible again.
  const byId = new Map(cards.map((card) => [card.messageId, card]))
  const ordered = facts.order
    ? facts.order.flatMap(({ messageId }) => {
        const card = byId.get(messageId)
        return card ? [card] : []
      })
    : cards
  return [...ordered, ...(facts.sending ?? [])].map((card) => ({
    ...card,
    line: queuedMessageCardLine({
      ...card,
      displayText: stripSentImagePromptMarkers(
        card.displayText ?? card.text,
        card.images?.length ?? 0
      )
    }),
    needsAttention: queuedMessageCardNeedsAttention(card),
    caption: queuedMessageCardCaption(card, facts.agentName, facts.statedFailures ?? [])
  }))
}
