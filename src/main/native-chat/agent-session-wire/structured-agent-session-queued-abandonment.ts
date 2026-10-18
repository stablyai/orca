// A queued card whose automatic send failed for good: the retry gave up on it
// (`StructuredAgentSessionRetry`), or the journal refused it. It reads as not sent at once, from
// memory, while its stored hold is tried once, in the background. Memory only: a restart's
// earlier-process settlement converts the card.

import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { backgroundJournalWrites } from './structured-agent-session-background-writes'

export class QueuedSendAbandonment {
  /** By chat, until a person moves the card, its hold lands or a later attempt sends it. */
  private readonly cards = new Map<string, string>()

  /** `publish`: re-sends what clients read, so the card shows as not sent and is not named next. */
  constructor(
    private readonly publish: (sessionId: string, journal: AgentSessionJournal) => void
  ) {}

  card(sessionId: string, journal: AgentSessionJournal | undefined): string | undefined {
    const messageId = this.cards.get(sessionId)
    if (messageId && journal) {
      const row = journal.queuedMessages.get(messageId)
      // Only this card's committed transition or stored hold can retire its memory hold.
      if (!row || row.state !== 'waiting' || row.holdReason !== null) {
        this.clear(sessionId, messageId)
        return undefined
      }
    }
    return messageId
  }

  clear(sessionId: string, messageId: string): void {
    if (this.cards.get(sessionId) === messageId) {
      this.cards.delete(sessionId)
    }
  }

  /** Marks the card, then tries its stored hold once; should that fail too, the mark still shows. */
  mark(sessionId: string, messageId: string, journal: AgentSessionJournal): void {
    this.cards.set(sessionId, messageId)
    void backgroundJournalWrites(journal)
      .queuedMessages.hold({ messageIds: [messageId], reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED })
      .then(() => {
        this.card(sessionId, journal)
      })
      .catch(() => undefined)
    this.publish(sessionId, journal)
  }
}
