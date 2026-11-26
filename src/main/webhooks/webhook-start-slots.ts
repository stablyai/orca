// At most this many of one bot's calls start at once, so waking from sleep doesn't launch them all.
const STARTS_AT_ONCE_PER_BOT = 4

export class WebhookStartSlots {
  private readonly starting = new Map<string, number>()
  private readonly waiting = new Map<string, (() => void)[]>()

  /** Waits for one of the bot's slots; the returned function gives it back. */
  async take(botId: string): Promise<() => void> {
    while ((this.starting.get(botId) ?? 0) >= STARTS_AT_ONCE_PER_BOT) {
      await new Promise<void>((resolve) => {
        this.waiting.set(botId, [...(this.waiting.get(botId) ?? []), resolve])
      })
    }
    this.starting.set(botId, (this.starting.get(botId) ?? 0) + 1)
    return () => {
      this.starting.set(botId, (this.starting.get(botId) ?? 1) - 1)
      const [next, ...rest] = this.waiting.get(botId) ?? []
      this.waiting.set(botId, rest)
      next?.()
    }
  }
}
