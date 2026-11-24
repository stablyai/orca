import { createHash } from 'node:crypto'

/** The drawing the cloud last took for a bot's Slack icon: its account's hash and mascot. */
export type BotSlackIconShown = { account: string | null; mascot: string }

// A final save waits at most this long at quit or relaunch, so a stuck disk never holds either up.
export const BOT_SLACK_ICON_SHOWN_SETTLE_MS = 2_000

type ShownDisk = {
  read: (botId: string) => Promise<BotSlackIconShown | null>
  /** Writes (or removes) the record, skipping a bot deleted by the time it would land. */
  write: (botId: string, shown: BotSlackIconShown | null) => Promise<void>
  exists: (botId: string) => boolean
}

function firstOf(set: Set<string>): string | undefined {
  for (const value of set) {
    return value
  }
  return undefined
}

// Per bot, the drawing the cloud last took, as kept across restarts: read once per run, and saved by one
// writer that never makes a caller wait. A failed save is tried again once on the poll's next answer, then
// on each real step and at quit; nothing is retried on a timer, and a lasting failure costs the poll nothing.
export class BotSlackIconShownRecords {
  private readonly byBot = new Map<string, BotSlackIconShown | null>()
  // Per bot not yet saved as it stands here, the revision a save must land to clear it.
  private readonly unsaved = new Map<string, number>()
  private revision = 0
  // Unsaved bots the writer goes to next, each once.
  private readonly due = new Set<string>()
  // Bots whose save failed and the poll's next answer may try once more.
  private readonly answerable = new Set<string>()
  // Bots already tried on an answer since their last step: they wait for a real step or quit.
  private readonly spent = new Set<string>()
  private running: Promise<void> | null = null
  // The bot being saved, so its deletion removes its files only after that save lands.
  private saving: { botId: string; done: Promise<void> } | null = null

  constructor(private readonly disk: ShownDisk) {}

  /** The signed-in account as kept with a drawing: a hash, so the file names no account. */
  static accountKey(account: string | null | undefined): string | null {
    return account ? createHash('sha256').update(account).digest('hex').slice(0, 16) : null
  }

  async get(botId: string): Promise<BotSlackIconShown | null> {
    const known = this.byBot.get(botId)
    if (known !== undefined) {
      return known
    }
    const shown = await this.disk.read(botId)
    // A bot deleted while it was read keeps nothing; one marked meanwhile keeps its newer record.
    if (this.disk.exists(botId) && !this.byBot.has(botId)) {
      this.byBot.set(botId, shown)
    }
    const kept = this.byBot.get(botId)
    return kept !== undefined ? kept : shown
  }

  /** What the cloud took for the bot now. Saved in the background: the caller never waits on the disk. */
  mark(botId: string, shown: BotSlackIconShown | null): void {
    if (!this.disk.exists(botId)) {
      return
    }
    const before = this.byBot.get(botId)
    if (
      !this.unsaved.has(botId) &&
      before !== undefined &&
      before?.account === shown?.account &&
      before?.mascot === shown?.mascot
    ) {
      return
    }
    this.byBot.set(botId, shown)
    this.unsaved.set(botId, ++this.revision)
    this.answerable.delete(botId)
    this.spent.delete(botId)
    this.due.add(botId)
    this.wake()
  }

  /** The poll answered: a save that failed goes once more. With none waiting this costs one check. */
  answered(): void {
    if (this.answerable.size === 0) {
      return
    }
    for (const botId of this.answerable) {
      this.spent.add(botId)
      this.due.add(botId)
    }
    this.answerable.clear()
    this.wake()
  }

  /** A real step (a bot write, a sign-in, the poll's outage ending): every unsaved record goes once. */
  stepped(): void {
    if (this.unsaved.size === 0) {
      return
    }
    this.answerable.clear()
    this.spent.clear()
    for (const botId of this.unsaved.keys()) {
      this.due.add(botId)
    }
    this.wake()
  }

  /** Quit or relaunch: every unsaved record goes once, and this settles when the writer is done. */
  settled(): Promise<void> {
    this.stepped()
    return this.running ?? Promise.resolve()
  }

  /** A deleted bot keeps nothing here; settles once a save of it already on its way has landed. */
  forget(botId: string): Promise<void> {
    this.byBot.delete(botId)
    this.unsaved.delete(botId)
    this.due.delete(botId)
    this.answerable.delete(botId)
    this.spent.delete(botId)
    return this.saving?.botId === botId ? this.saving.done : Promise.resolve()
  }

  private wake(): void {
    this.running ??= this.drain().finally(() => {
      this.running = null
    })
  }

  // One save at a time, each of the bot's latest record; a bot asked for again while due goes once.
  private async drain(): Promise<void> {
    for (let botId = firstOf(this.due); botId !== undefined; botId = firstOf(this.due)) {
      this.due.delete(botId)
      const revision = this.unsaved.get(botId)
      const shown = this.byBot.get(botId)
      if (revision === undefined || shown === undefined) {
        continue
      }
      const done = this.disk.write(botId, shown).then(
        () => {
          // A newer record marked meanwhile is due on its own.
          if (this.unsaved.get(botId) === revision) {
            this.unsaved.delete(botId)
            this.spent.delete(botId)
          }
        },
        () => {
          if (this.unsaved.get(botId) === revision && !this.spent.has(botId)) {
            this.answerable.add(botId)
          }
        }
      )
      this.saving = { botId, done }
      await done
      this.saving = null
    }
  }
}
