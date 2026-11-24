// Bots whose drawn icon the cloud failed to take: sent again on a real step, never by the retry timer. The poll
// answering after a missed call resends each once; a real step for the bot (or a fresh one for all) gives it back.
export class BotAvatarOwed {
  private readonly owed = new Set<string>()
  // Owed bots already resent on an answered poll: they wait for a real step, never the poll's pace.
  private readonly answered = new Set<string>()

  add(botId: string): void {
    this.owed.add(botId)
  }

  has(botId: string): boolean {
    return this.owed.has(botId)
  }

  /** A real step for this bot (its write, a new drawing, a send taken): nothing is owed or used up. */
  delete(botId: string): void {
    this.owed.delete(botId)
    this.answered.delete(botId)
  }

  /** A real step for every bot. */
  clear(): void {
    this.owed.clear()
    this.answered.clear()
  }

  /** The bots to send again now, no longer owed: on an answered poll, only those not resent since a step. */
  take(fresh: boolean): string[] {
    if (fresh) {
      this.answered.clear()
    }
    const due = [...this.owed].filter((botId) => fresh || !this.answered.has(botId))
    for (const botId of due) {
      this.owed.delete(botId)
      if (!fresh) {
        this.answered.add(botId)
      }
    }
    return due
  }

  keys(): IterableIterator<string> {
    return new Set([...this.owed, ...this.answered]).values()
  }
}
