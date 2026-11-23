// Closes the chats automation runs open as a new conversation each time, once each has sat idle for
// its bot's Close after. One timer for the nearest deadline; the list survives a restart.
import { z } from 'zod'
import type { Bot } from '../../shared/bot-types'
import {
  botRunChatCloseAfterMs,
  type BotRunChatCloseAfter
} from '../../shared/bots/bot-run-chat-close'

const MAX_TIMER_DELAY_MS = 2_147_483_647
// Bounded for bots set to Never, whose chats stay listed until they close or the setting changes;
// past it their chats go first, so a busy bot's 7 days of runs still reach their deadlines.
const MAX_TRACKED_CHATS = 5000
// A sweep that failed (its chats unreadable) waits this long before it tries again.
const FAILED_SWEEP_RETRY_MS = 60 * 60 * 1000
// Chats due this close together share one sweep, so staggered runs list the bot's chats once.
const SWEEP_COALESCE_MS = 10 * 60 * 1000

const EntrySchema = z.object({
  sessionId: z.string().min(1),
  botId: z.string().min(1),
  /** When its countdown last started: the run's end, or the last time it was busy. */
  since: z.number()
})
type Entry = z.infer<typeof EntrySchema>
const FileSchema = z.object({ chats: z.array(EntrySchema) })

/** One of the bot's chats as the closer sees it; null when it is gone or closed. */
export type BotRunChatState = {
  lastActivityAt: number
  /** Home Chats and chats linked to a thread never close on their own. */
  kept: boolean
}

export type BotRunChatCloseDeps = {
  /** This profile's list; a profile switch names another file. */
  path: () => string
  read: (path: string) => Promise<string | null>
  write: (path: string, text: string) => Promise<void>
  now: () => number
  bots: () => readonly Bot[]
  hostDefault: () => BotRunChatCloseAfter
  /** The bot's chats, read once per sweep. */
  chatsOf: (bot: Bot) => Promise<(sessionId: string) => BotRunChatState | null>
  /** The chat's last activity now, read from its record alone; null once it is gone. */
  lastActivityAt: (sessionId: string) => number | null
  /** Working, waiting on someone, open on a screen, or owning open items. */
  busy: (bot: Bot, sessionId: string) => Promise<boolean>
  /** Closes it unless it is working; true once it closed. */
  close: (sessionId: string) => Promise<boolean>
}

export class BotRunChatCloser {
  private entries: { path: string; list: Entry[] } | null = null
  private failedAt: number | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerAt: number | undefined
  private windows = ''
  // Every read and write of the list runs here, one at a time.
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: BotRunChatCloseDeps) {}

  /** A run's own conversation just finished: its countdown starts now. */
  arm(bot: Pick<Bot, 'id'>, sessionId: string): void {
    const since = this.deps.now()
    void this.serial(async () => {
      const entries = (await this.all()).filter((entry) => entry.sessionId !== sessionId)
      entries.push({ sessionId, botId: bot.id, since })
      await this.save(this.bounded(entries))
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

  /** Closes every chat that is due and idle; one that is busy starts its countdown again. */
  sweep(): Promise<void> {
    return this.serial(async () => {
      try {
        await this.sweepDue()
        this.failedAt = null
      } catch (error) {
        this.failedAt = this.deps.now()
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

  private async sweepDue(): Promise<void> {
    const now = this.deps.now()
    const bots = new Map(this.deps.bots().map((bot) => [bot.id, bot]))
    const chats = new Map<string, (sessionId: string) => BotRunChatState | null>()
    const kept: Entry[] = []
    let changed = false
    for (const entry of await this.all()) {
      const bot = bots.get(entry.botId)
      const ms = bot ? botRunChatCloseAfterMs(bot, this.deps.hostDefault()) : 0
      if (bot && (ms === null || entry.since + ms > now + SWEEP_COALESCE_MS)) {
        kept.push(entry)
        continue
      }
      changed = true
      if (!bot || ms === null) {
        continue
      }
      let chatOf = chats.get(bot.id)
      if (!chatOf) {
        chatOf = await this.deps.chatsOf(bot)
        chats.set(bot.id, chatOf)
      }
      const chat = chatOf(entry.sessionId)
      if (!chat || chat.kept) {
        continue
      }
      if (chat.lastActivityAt + ms > now + SWEEP_COALESCE_MS) {
        kept.push({ ...entry, since: chat.lastActivityAt })
      } else if (await this.deps.busy(bot, entry.sessionId)) {
        kept.push({ ...entry, since: this.deps.now() })
      } else if (!this.stillDue(entry, chat.lastActivityAt)) {
        // A turn or a new Close after arrived while the checks ran.
        kept.push(entry)
      } else if (!(await this.deps.close(entry.sessionId))) {
        kept.push({ ...entry, since: this.deps.now() })
      }
    }
    if (changed) {
      await this.save(kept)
    }
  }

  private stillDue(entry: Entry, seenActivityAt: number): boolean {
    const bot = this.deps.bots().find((candidate) => candidate.id === entry.botId)
    const ms = bot ? botRunChatCloseAfterMs(bot, this.deps.hostDefault()) : null
    const last = Math.max(
      entry.since,
      seenActivityAt,
      this.deps.lastActivityAt(entry.sessionId) ?? seenActivityAt
    )
    return ms !== null && last + ms <= this.deps.now() + SWEEP_COALESCE_MS
  }

  private bounded(entries: Entry[]): Entry[] {
    const over = entries.length - MAX_TRACKED_CHATS
    if (over <= 0) {
      return entries
    }
    const never = new Set(
      this.deps
        .bots()
        .filter((bot) => botRunChatCloseAfterMs(bot, this.deps.hostDefault()) === null)
        .map((bot) => bot.id)
    )
    const byPriority = [
      ...entries.filter((entry) => never.has(entry.botId)),
      ...entries.filter((entry) => !never.has(entry.botId))
    ]
    const dropped = new Set(byPriority.slice(0, over).map((entry) => entry.sessionId))
    return entries.filter((entry) => !dropped.has(entry.sessionId))
  }

  private nextDeadline(entries: readonly Entry[]): number | null {
    const bots = new Map(this.deps.bots().map((bot) => [bot.id, bot]))
    let next: number | null = null
    for (const entry of entries) {
      const bot = bots.get(entry.botId)
      // A deleted bot's entry is dropped by the next sweep.
      const ms = bot ? botRunChatCloseAfterMs(bot, this.deps.hostDefault()) : 0
      if (ms !== null && (next === null || entry.since + ms < next)) {
        next = entry.since + ms
      }
    }
    return next !== null && this.failedAt !== null
      ? Math.max(next, this.failedAt + FAILED_SWEEP_RETRY_MS)
      : next
  }

  private windowsKey(): string {
    return JSON.stringify([
      this.deps.hostDefault(),
      this.deps.bots().map((bot) => [bot.id, bot.runChatsCloseAfter ?? null])
    ])
  }

  private async all(): Promise<Entry[]> {
    const path = this.deps.path()
    if (this.entries?.path !== path) {
      let list: Entry[] = []
      try {
        const text = await this.deps.read(path)
        list = text ? FileSchema.parse(JSON.parse(text)).chats : []
      } catch (error) {
        // Unreadable: those chats stay open, as before this existed.
        console.warn('[bots] finished run chat list unreadable; starting it again', error)
      }
      this.entries = { path, list }
    }
    return this.entries.list
  }

  private async save(list: Entry[]): Promise<void> {
    const path = this.deps.path()
    this.entries = { path, list }
    try {
      await this.deps.write(path, JSON.stringify({ chats: list }))
    } catch (error) {
      console.warn('[bots] could not save the finished run chat list', error)
    }
  }
}
