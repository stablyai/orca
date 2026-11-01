import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'

/** Pointer delivery transfers ownership to a card before any submitted turn exists. */
export class StructuredQueuedNativeResponses {
  private readonly messages = new Map<string, readonly string[]>()

  reset(journal: AgentSessionJournal): void {
    this.messages.clear()
    for (const card of journal.queuedMessages.list()) {
      this.observe(card)
    }
  }

  changed(journal: AgentSessionJournal, row: JournalRow): void {
    const id =
      row.kind === 'queue'
        ? row.messageId
        : row.kind === 'submission'
          ? row.queuedMessageId
          : row.kind === 'dispatch'
            ? journal.submission(row.clientMessageId)?.queuedMessageId
            : undefined
    if (id) {
      this.changedCard(journal, id)
    }
  }

  /** The card's current value decides: a present card is re-read, a gone one forgotten. */
  changedCard(journal: AgentSessionJournal, id: string): void {
    const card = journal.queuedMessages.get(id)
    if (card) {
      this.observe(card)
    } else {
      this.messages.delete(id)
    }
  }

  private observe(card: QueuedMessageRow): void {
    const source = card.body.from?.orchestration
    if (
      (card.state === 'waiting' || card.state === 'returned') &&
      source?.message === 'mail-notice'
    ) {
      this.messages.set(
        card.messageId,
        source.messages.map((message) => message.messageId)
      )
    } else {
      this.messages.delete(card.messageId)
    }
  }

  *pendingWith(pending: ReadonlySet<string>, disposed: ReadonlySet<string>): Iterable<string> {
    yield* pending
    for (const messages of this.messages.values()) {
      for (const message of messages) {
        if (!disposed.has(message)) {
          yield message
        }
      }
    }
  }
}
