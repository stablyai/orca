import { createHash } from 'node:crypto'
import type { BotSlackIconShown, BotSlackIcons } from '../bots/bot-slack-icon-store'

// Per bot, the drawing the cloud last took for its Slack icon (its account's hash and mascot), as the icon
// store keeps it across restarts: read once per run, written only when it changes.
export class BotAvatarShown {
  private readonly byBot = new Map<string, BotSlackIconShown | null>()
  // Bots whose record isn't on disk as it stands here: their next mark or flush writes it.
  private readonly unsaved = new Set<string>()
  // Writes go one at a time, each writing the bot's record as it stands when its turn comes, so an older
  // retry never lands after a newer record.
  private writes: Promise<void> = Promise.resolve()

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
      await this.write(botId)
    }
  }

  /** Writes again the records whose write failed, on the next poll answer or bot write, so a passing disk
   *  error doesn't leave a restart sending older art. Nothing to write costs nothing. */
  async flush(): Promise<void> {
    // One bot's write failing again leaves the others to go.
    await Promise.all([...this.unsaved].map((botId) => this.write(botId).catch(() => {})))
  }

  private write(botId: string): Promise<void> {
    const run = this.writes.then(async () => {
      const shown = this.byBot.get(botId)
      if (!this.exists(botId) || shown === undefined || !this.unsaved.has(botId)) {
        this.unsaved.delete(botId)
        return
      }
      await this.store.markShown(botId, shown)
      // A newer record marked meanwhile has its own write queued after this one.
      if (this.byBot.get(botId) === shown) {
        this.unsaved.delete(botId)
      }
    })
    this.writes = run.catch(() => {})
    return run
  }

  keys(): IterableIterator<string> {
    return this.byBot.keys()
  }

  delete(botId: string): void {
    this.byBot.delete(botId)
    this.unsaved.delete(botId)
  }
}
