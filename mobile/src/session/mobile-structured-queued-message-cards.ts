import { stripSentImagePromptMarkers } from '../../../src/shared/native-chat/transcript/native-chat-image-transcript-markers'
// The shared projection decides each card's hold; this layer words it for the phone.

import type { AgentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionWriteNoticeEnglish } from '../../../src/shared/agent-session-refusal-notice'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage
} from '../../../src/shared/agent-session-wire'
import {
  projectQueuedMessageCards,
  queuedMessageCardLine,
  queuedMessageCardNeedsAttention,
  queuedMessageReturnedNotice,
  type QueuedMessageCard
} from '../../../src/shared/structured-agent-session-queued-cards'
import { agentMessageAttribution } from './mobile-agent-message-attribution'

export type MobileQueuedMessageCard = QueuedMessageCard & {
  /** The text, or for a card of images alone, the image's name or their count. */
  line: string
  needsAttention: boolean
  // Leave plain waits uncaptioned; the question or queue-pause row already explains the hold.
  caption: string | null
  attribution: string | null
}

function queuedMessageCardCaption(
  card: QueuedMessageCard,
  agentName: string | undefined,
  statedFailures: readonly AgentSessionFailureFact[]
): string | null {
  switch (card.hold) {
    case 'returned': {
      const notice = queuedMessageReturnedNotice(card, agentName, statedFailures)
      return notice === 'withdrawn'
        ? 'Stopped before it was sent'
        : agentSessionWriteNoticeEnglish(notice)
    }
    case 'paused':
      // Absent or unknown (newer host) marker: a plain pause, promising no release rule.
      if (card.pausedReason !== QUEUED_MESSAGE_PAUSED_SEND_FAILED) {
        return 'Paused'
      }
      return card.waitsForAgent
        ? "Couldn't send — tap Send to retry once the agent finishes"
        : "Couldn't send — tap Send to retry"
    case 'behind-returned':
      return 'Waiting — a message ahead needs attention'
    // The phone draws no card for a send still on its way.
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
  } = {}
): MobileQueuedMessageCard[] {
  return projectQueuedMessageCards(queuedMessages, submissions, facts).map((card) => ({
    ...card,
    line: queuedMessageCardLine({
      ...card,
      text: stripSentImagePromptMarkers(card.text, card.images?.length ?? 0)
    }),
    needsAttention: queuedMessageCardNeedsAttention(card),
    caption: queuedMessageCardCaption(card, facts.agentName, facts.statedFailures ?? []),
    attribution: agentMessageAttribution('From', card.from)
  }))
}
