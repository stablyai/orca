import type { ConnectorBack } from './connector-reach'

// Bots whose drawn icon the cloud failed to take: sent again on a real step, never by the retry timer. The poll
// answering resends a failed (not refused) one once; a real step for the bot, a sign-in or the poll's own outage
// ending gives that back. One the cloud refused outright (it doesn't know the bot) waits for a sign-in or a step
// of its own.
export class BotAvatarOwed {
  private readonly owed = new Set<string>()
  // Owed bots the poll's next answer may resend: failed, not refused, and not yet resent on an answer. A
  // healthy poll visits only these, so debt it can't send costs it nothing.
  private readonly answerable = new Set<string>()
  // Owed bots already resent on an answer: they wait for a real step, never the poll's pace.
  private readonly answered = new Set<string>()
  private readonly refused = new Set<string>()

  add(botId: string, refused = false): void {
    this.owed.add(botId)
    if (refused) {
      this.refused.add(botId)
      this.answerable.delete(botId)
    } else if (!this.answered.has(botId)) {
      this.answerable.add(botId)
    }
  }

  has(botId: string): boolean {
    return this.owed.has(botId)
  }

  /** A real step for this bot (its write, a new drawing, a send taken): nothing is owed or used up. */
  delete(botId: string): void {
    this.owed.delete(botId)
    this.answerable.delete(botId)
    this.answered.delete(botId)
    this.refused.delete(botId)
  }

  /** A real step for every bot. */
  clear(): void {
    this.owed.clear()
    this.answerable.clear()
    this.answered.clear()
    this.refused.clear()
  }

  /** The bots to send again now, no longer owed: on an answered poll, only those not resent since a step;
   *  a refused one only on a sign-in. */
  take(why: ConnectorBack): string[] {
    if (why === 'answered') {
      const due = [...this.answerable]
      for (const botId of due) {
        this.owed.delete(botId)
        this.answerable.delete(botId)
        this.answered.add(botId)
      }
      return due
    }
    this.answered.clear()
    const due = [...this.owed].filter((botId) => why === 'signedIn' || !this.refused.has(botId))
    for (const botId of due) {
      this.owed.delete(botId)
      this.answerable.delete(botId)
      this.refused.delete(botId)
    }
    return due
  }

  keys(): IterableIterator<string> {
    return new Set([...this.owed, ...this.answered]).values()
  }
}
