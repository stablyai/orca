// A queued card whose automatic send the retry gave up on (`StructuredAgentSessionRetry`): it reads
// as not sent at once, from memory, while its stored hold is tried once. Memory only: a restart's
// earlier-process settlement converts the card.

import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-wire'
import type { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'

export class QueuedSendAbandonment {
  /** By chat, until a person moves the card, its hold lands or a later attempt sends it. */
  private readonly cards = new Map<string, string>()

  card(sessionId: string): string | undefined {
    return this.cards.get(sessionId)
  }

  clear(sessionId: string): void {
    this.cards.delete(sessionId)
  }

  /** Marks the card, then tries its stored hold once; should that fail too, the mark still shows. */
  mark(sessionId: string, messageId: string, queued: Pick<JournalQueuedMessages, 'hold'>): void {
    this.cards.set(sessionId, messageId)
    void queued
      .hold({
        messageIds: [messageId],
        reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED,
        background: true
      })
      .then(() => {
        if (this.cards.get(sessionId) === messageId) {
          this.cards.delete(sessionId)
        }
      })
      .catch(() => undefined)
  }
}
