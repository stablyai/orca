// Closes the chats automation runs open as a new conversation each time, once each has sat idle for
// its bot's Close after. One timer for the nearest deadline; the list survives a restart.
import { z } from 'zod'
import type { Bot } from '../../shared/bot-types'
import {
  botRunChatCloseAfterMs,
  type BotRunChatCloseAfter
} from '../../shared/bots/bot-run-chat-close'

const MAX_TIMER_DELAY_MS = 2_147_483_647
// Holds a week of runs from a bot that runs every minute, twice over; past it, chats of bots this
// profile doesn't have go first, then the oldest, down to 90% so a full list isn't rewritten per run.
const MAX_TRACKED_CHATS = 20_000
const TRIMMED_TRACKED_CHATS = 18_000
// A sweep that failed (chat records unavailable) waits an hour, doubling to a day.
const FAILED_SWEEP_RETRY_MS = 60 * 60 * 1000
const MAX_FAILED_SWEEP_RETRY_MS = 24 * 60 * 60 * 1000
// Chats due this close together share one sweep.
const SWEEP_COALESCE_MS = 10 * 60 * 1000

const EntrySchema = z.object({
  sessionId: z.string().min(1),
  botId: z.string().min(1),
  /** When its countdown last started: the run's end, or the last time it was busy or active. */
  since: z.number()
})
type Entry = z.infer<typeof EntrySchema>

/** One of the bot's chats as the closer sees it now; null when it is gone or closed. */
export type BotRunChatState = {
  lastActivityAt: number
  /** Home Chats, chats linked to a thread and chats this host can't vouch for never close on their own. */
  kept: boolean
}

export type BotRunChatCloseDeps = {
  /** This host's list, one entry per line; the last line for a chat wins. */
  path: () => string
  read: (path: string) => Promise<string | null>
  append: (path: string, text: string) => Promise<void>
  write: (path: string, text: string) => Promise<void>
  now: () => number
  bots: () => readonly Bot[]
  hostDefault: () => BotRunChatCloseAfter
  /** Throws while chat records can't be read, so a sweep then never mistakes a chat for gone. */
  ready: () => Promise<void>
  /** Reads this one chat's record. */
  chat: (bot: Bot, sessionId: string) => BotRunChatState | null
  /** `held`: someone keeps it (open on a screen or in a tab, owning an open item, or the chat an
   *  automation runs in), so it stays open for good. `working`: a turn or a usage-limit wait. */
  use: (bot: Bot, sessionId: string) => Promise<'held' | 'working' | 'free'>
  /** Closes it once `admit` agrees in the session's own lane, and only while it is idle. */
  close: (sessionId: string, admit: () => boolean) => Promise<boolean>
}

export class BotRunChatCloser {
  private entries: { path: string; byChat: Map<string, Entry> } | null = null
  private failedAt: number | null = null
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerAt: number | undefined
  private windows = ''
  // Every read and write of the list runs here, one at a time.
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: BotRunChatCloseDeps) {}

  /** A run's own conversation just finished: its countdown starts now. A bot on Never tracks none. */
  arm(bot: Bot, sessionId: string): void {
    if (this.closeAfterMs(bot) === null) {
      return
    }
    const entry: Entry = { sessionId, botId: bot.id, since: this.deps.now() }
    void this.serial(async () => {
      const byChat = await this.all()
      byChat.delete(sessionId)
      byChat.set(sessionId, entry)
      if (byChat.size > MAX_TRACKED_CHATS) {
        this.evict(byChat)
        await this.rewrite()
      } else {
        // Leading newline: a line a crash cut short never swallows this one.
        await this.deps.append(this.deps.path(), `\n${JSON.stringify(entry)}`)
      }
      await this.rearmNow()
    })
  }

  /** A deleted bot's chats are no longer this closer's. */
  forget(botId: string): void {
    this.drop((entry) => entry.botId === botId)
  }

  /** The chat asked another bot something: its answer comes back here, so it stays open. */
  keepOpen(sessionId: string): void {
    this.drop((entry) => entry.sessionId === sessionId)
  }

  private drop(match: (entry: Entry) => boolean): void {
    void this.serial(async () => {
      const byChat = await this.all()
      const before = byChat.size
      for (const [sessionId, entry] of byChat) {
        if (match(entry)) {
          byChat.delete(sessionId)
        }
      }
      if (byChat.size !== before) {
        await this.rewrite()
      }
      await this.rearmNow()
    })
  }

  /** Settings or bots changed: a new Close after moves the timer, nothing else does. */
  settingsChanged(): void {
    if (this.windowsKey() !== this.windows) {
      this.rearm()
    }
  }

  /** Sets the timer for the nearest deadline; reads no chat until one is due. */
  rearm(): void {
    void this.serial(() => this.rearmNow())
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = undefined
    this.timerAt = undefined
  }

  /** Closes every chat that is due and idle; any other due chat starts its countdown again. */
  sweep(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.sweepDue()
        this.failedAt = null
        this.failures = 0
      } catch (error) {
        this.failedAt = this.deps.now()
        this.failures += 1
        console.warn('[bots] closing finished run chats failed', error)
      }
      await this.rearmNow()
    })
  }

  private serial(op: () => Promise<void>): Promise<void> {
    const next = this.queue.then(op).catch((error: unknown) => {
      console.warn('[bots] finished run chat list update failed', error)
    })
    this.queue = next
    return next
  }

  private async sweepDue(): Promise<void> {
    const now = this.deps.now()
    const byChat = await this.all()
    const bots = new Map(this.deps.bots().map((bot) => [bot.id, bot]))
    const due = [...byChat.values()].flatMap((entry) => {
      const bot = bots.get(entry.botId)
      const ms = bot ? this.closeAfterMs(bot) : null
      return bot && ms !== null && entry.since + ms <= now + SWEEP_COALESCE_MS
        ? [{ entry, bot }]
        : []
    })
    if (due.length === 0) {
      return
    }
    await this.deps.ready()
    for (const { entry, bot } of due) {
      const next = await this.settle(entry, bot, now)
      if (next) {
        byChat.set(entry.sessionId, next)
      } else {
        byChat.delete(entry.sessionId)
      }
    }
    await this.rewrite()
  }

  /** What stays of a due entry: null once the chat closed or isn't one to close, else a later start. */
  private async settle(entry: Entry, bot: Bot, now: number): Promise<Entry | null> {
    const waiting = (): Entry | 'due' | null => {
      const chat = this.deps.chat(bot, entry.sessionId)
      if (!chat || chat.kept) {
        return null
      }
      // Re-read each time: Close after can change while the checks run.
      const current = this.deps.bots().find((candidate) => candidate.id === bot.id)
      const ms = current ? this.closeAfterMs(current) : null
      const since = Math.max(entry.since, chat.lastActivityAt)
      return ms === null || since + ms > now + SWEEP_COALESCE_MS ? { ...entry, since } : 'due'
    }
    const first = waiting()
    if (first !== 'due') {
      return first
    }
    const use = await this.deps.use(bot, entry.sessionId)
    if (use !== 'free') {
      return use === 'held' ? null : { ...entry, since: this.deps.now() }
    }
    // A turn, a wake or a new Close after may come at any point up to the close itself.
    const closed = await this.deps.close(entry.sessionId, () => waiting() === 'due')
    if (closed) {
      return null
    }
    const after = waiting()
    return after === 'due' ? { ...entry, since: this.deps.now() } : after
  }

  private async rearmNow(): Promise<void> {
    this.windows = this.windowsKey()
    const next = this.nextDeadline(await this.all())
    if (this.timer && this.timerAt === next) {
      return
    }
    this.clear()
    if (next === null) {
      return
    }
    const timer = setTimeout(
      () => {
        if (this.timer === timer) {
          this.timer = undefined
          this.timerAt = undefined
          void this.sweep()
        }
      },
      Math.min(Math.max(0, next - this.deps.now()), MAX_TIMER_DELAY_MS)
    )
    timer.unref?.()
    this.timer = timer
    this.timerAt = next
  }

  private nextDeadline(byChat: Map<string, Entry>): number | null {
    const bots = new Map(this.deps.bots().map((bot) => [bot.id, bot]))
    let next: number | null = null
    for (const entry of byChat.values()) {
      const bot = bots.get(entry.botId)
      // A bot this profile doesn't have keeps its chats for the profile that does.
      const ms = bot ? this.closeAfterMs(bot) : null
      if (ms !== null && (next === null || entry.since + ms < next)) {
        next = entry.since + ms
      }
    }
    const backoff = Math.min(
      FAILED_SWEEP_RETRY_MS * 2 ** Math.max(0, this.failures - 1),
      MAX_FAILED_SWEEP_RETRY_MS
    )
    return next !== null && this.failedAt !== null ? Math.max(next, this.failedAt + backoff) : next
  }

  private closeAfterMs(bot: Bot): number | null {
    return botRunChatCloseAfterMs(bot, this.deps.hostDefault())
  }

  private evict(byChat: Map<string, Entry>): void {
    const known = new Set(this.deps.bots().map((bot) => bot.id))
    const order = [...byChat.values()]
    const byPriority = [
      ...order.filter((entry) => !known.has(entry.botId)),
      ...order.filter((entry) => known.has(entry.botId))
    ]
    byPriority
      .slice(0, byChat.size - TRIMMED_TRACKED_CHATS)
      .forEach((entry) => byChat.delete(entry.sessionId))
  }

  private windowsKey(): string {
    return JSON.stringify([
      this.deps.hostDefault(),
      this.deps.bots().map((bot) => [bot.id, bot.runChatsCloseAfter ?? null])
    ])
  }

  private async all(): Promise<Map<string, Entry>> {
    const path = this.deps.path()
    if (this.entries?.path !== path) {
      const byChat = new Map<string, Entry>()
      const text = await this.deps.read(path).catch(() => null)
      for (const line of text?.split('\n') ?? []) {
        const entry = parseEntry(line)
        if (entry) {
          byChat.delete(entry.sessionId)
          byChat.set(entry.sessionId, entry)
        }
      }
      this.entries = { path, byChat }
    }
    return this.entries.byChat
  }

  private async rewrite(): Promise<void> {
    const byChat = await this.all()
    const text = [...byChat.values()].map((entry) => `${JSON.stringify(entry)}\n`).join('')
    try {
      await this.deps.write(this.deps.path(), text)
    } catch (error) {
      console.warn('[bots] could not save the finished run chat list', error)
    }
  }
}

// An unreadable line leaves that chat open, as before this existed.
function parseEntry(line: string): Entry | null {
  if (!line.trim()) {
    return null
  }
  try {
    const parsed = EntrySchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
