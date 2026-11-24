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
  // Per bot, its write waiting for its turn: asking again joins it, so the queue holds at most one per bot.
  private readonly waiting = new Map<string, Promise<void>>()
  private flushing: Promise<void> | null = null
  // Unsaved bots already written again on a poll answer: they wait for a real step, never the poll's pace.
  private readonly spent = new Set<string>()
  // A real step asked while a flush was going: one more flush follows it.
  private stepWaiting = false

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
      this.spent.delete(botId)
      await this.write(botId)
    }
  }

  /** Writes again the records whose write failed: once on the next poll answer, and again on each real step
   *  (a bot write, a sign-in, the poll's outage ending), so a passing disk error doesn't leave a restart
   *  sending older art and a lasting one costs the poll nothing. Nothing to write costs nothing. */
  flush(onAnswer = false): Promise<void> {
    // One in progress is joined, so a stuck write holds one flush however many poll answers ask.
    if (this.flushing) {
      this.stepWaiting ||= !onAnswer
      return this.flushing
    }
    if (!onAnswer) {
      this.spent.clear()
    }
    const due = [...this.unsaved].filter((botId) => !this.spent.has(botId))
    if (onAnswer) {
      for (const botId of due) {
        this.spent.add(botId)
      }
    }
    // One bot's write failing again leaves the others to go.
    this.flushing = Promise.all(due.map((botId) => this.write(botId).catch(() => {}))).then(() => {
      this.flushing = null
      if (this.stepWaiting) {
        this.stepWaiting = false
        return this.flush()
      }
    })
    return this.flushing
  }

  private write(botId: string): Promise<void> {
    const queued = this.waiting.get(botId)
    if (queued) {
      return queued
    }
    const run = this.writes.then(async () => {
      this.waiting.delete(botId)
      const shown = this.byBot.get(botId)
      if (!this.exists(botId) || shown === undefined || !this.unsaved.has(botId)) {
        this.unsaved.delete(botId)
        this.spent.delete(botId)
        return
      }
      await this.store.markShown(botId, shown)
      // A newer record marked meanwhile has its own write queued after this one.
      if (this.byBot.get(botId) === shown) {
        this.unsaved.delete(botId)
        this.spent.delete(botId)
      }
    })
    this.waiting.set(botId, run)
    this.writes = run.catch(() => {})
    return run
  }

  keys(): IterableIterator<string> {
    return this.byBot.keys()
  }

  delete(botId: string): void {
    this.byBot.delete(botId)
    this.unsaved.delete(botId)
    this.spent.delete(botId)
  }
}
