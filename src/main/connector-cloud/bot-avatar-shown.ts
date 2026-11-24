import { createHash } from 'node:crypto'
import type { BotSlackIconShown, BotSlackIcons } from '../bots/bot-slack-icon-store'

// Per bot, the drawing the cloud last took for its Slack icon (its account's hash and mascot), as the icon
// store keeps it across restarts: read once per run, written only when it changes.
export class BotAvatarShown {
  private readonly byBot = new Map<string, BotSlackIconShown | null>()
  // Bots whose last write failed: their next mark writes again, even with the same value.
  private readonly unsaved = new Set<string>()

  constructor(
    private readonly store: Pick<BotSlackIcons, 'shown' | 'markShown'>,
    private readonly exists: (botId: string) => boolean
  ) {}

  /** The signed-in account as kept with a drawing: a hash, so the file names no account. */
  static accountKey(account: string | null | undefined): string | null {
    return account ? createHash('sha256').update(account).digest('hex').slice(0, 16) : null
  }

  async get(botId: string): Promise<BotSlackIconShown | null> {
    const known = this.byBot.get(botId)
    if (known !== undefined) {
      return known
    }
    const shown = await this.store.shown(botId)
    // A bot deleted while it was read keeps nothing here.
    if (this.exists(botId)) {
      this.byBot.set(botId, shown)
    }
    return shown
  }

  async mark(botId: string, shown: BotSlackIconShown | null): Promise<void> {
    const before = await this.get(botId)
    if (
      this.unsaved.has(botId) ||
      before?.account !== shown?.account ||
      before?.mascot !== shown?.mascot
    ) {
      this.byBot.set(botId, shown)
      this.unsaved.add(botId)
      await this.store.markShown(botId, shown)
      this.unsaved.delete(botId)
    }
  }

  /** Writes again the records whose write failed, on the next poll answer or bot write, so a passing disk
   *  error doesn't leave a restart sending older art. Nothing to write costs nothing. */
  async flush(): Promise<void> {
    for (const botId of this.unsaved) {
      if (!this.exists(botId)) {
        this.unsaved.delete(botId)
        continue
      }
      try {
        await this.store.markShown(botId, this.byBot.get(botId) ?? null)
        this.unsaved.delete(botId)
      } catch {
        return
      }
    }
  }

  keys(): IterableIterator<string> {
    return this.byBot.keys()
  }

  delete(botId: string): void {
    this.byBot.delete(botId)
    this.unsaved.delete(botId)
  }
}
