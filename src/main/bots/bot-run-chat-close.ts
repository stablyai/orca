// Closes the chats automation runs open as a new conversation each time, once each has sat idle for
// its bot's Close after. One timer for the nearest deadline; the list survives a restart.
import { z } from 'zod'
import type { Bot } from '../../shared/bot-types'
import {
  botRunChatCloseAfterMs,
  type BotRunChatCloseAfter
} from '../../shared/bots/bot-run-chat-close'

const MAX_TIMER_DELAY_MS = 2_147_483_647
// Bounded for bots set to Never, whose chats stay listed until they close or the setting changes.
const MAX_TRACKED_CHATS = 1000
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
  read: (path: string) => string | null
  write: (path: string, text: string) => void
  now: () => number
  bots: () => readonly Bot[]
  hostDefault: () => BotRunChatCloseAfter
  /** The bot's chats, read once per sweep. */
  chatsOf: (bot: Bot) => Promise<(sessionId: string) => BotRunChatState | null>
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
  private sweeping: Promise<void> | null = null
  private windows = ''

  constructor(private readonly deps: BotRunChatCloseDeps) {}

  /** A run's own conversation just finished: its countdown starts now. */
  arm(bot: Pick<Bot, 'id'>, sessionId: string): void {
    const entries = this.all().filter((entry) => entry.sessionId !== sessionId)
    entries.push({ sessionId, botId: bot.id, since: this.deps.now() })
    this.save(entries.slice(-MAX_TRACKED_CHATS))
    this.rearm()
  }

  /** Settings or bots changed: a new Close after moves the timer, nothing else does. */
  settingsChanged(): void {
    const windows = this.windowsKey()
    if (windows !== this.windows) {
      this.rearm()
    }
  }

  /** Sets the timer for the nearest deadline; reads no chat until one is due. */
  rearm(): void {
    this.windows = this.windowsKey()
    const next = this.nextDeadline()
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

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = undefined
    this.timerAt = undefined
  }

  /** Closes every chat that is due and idle; one that is busy starts its countdown again. */
  sweep(): Promise<void> {
    this.sweeping ??= this.sweepDue()
      .then(() => {
        this.failedAt = null
      })
      .catch((error: unknown) => {
        this.failedAt = this.deps.now()
        console.warn('[bots] closing finished run chats failed', error)
      })
      .finally(() => {
        this.sweeping = null
        this.rearm()
      })
    return this.sweeping
  }

  private async sweepDue(): Promise<void> {
    const now = this.deps.now()
    const bots = new Map(this.deps.bots().map((bot) => [bot.id, bot]))
    const chats = new Map<string, (sessionId: string) => BotRunChatState | null>()
    const outcome = new Map<string, Entry | null>()
    for (const entry of this.all()) {
      const bot = bots.get(entry.botId)
      if (!bot) {
        outcome.set(entry.sessionId, null)
        continue
      }
      const ms = botRunChatCloseAfterMs(bot, this.deps.hostDefault())
      if (ms === null || entry.since + ms > now + SWEEP_COALESCE_MS) {
        continue
      }
      let chatOf = chats.get(bot.id)
      if (!chatOf) {
        chatOf = await this.deps.chatsOf(bot)
        chats.set(bot.id, chatOf)
      }
      const chat = chatOf(entry.sessionId)
      if (!chat || chat.kept) {
        outcome.set(entry.sessionId, null)
      } else if (chat.lastActivityAt + ms > now + SWEEP_COALESCE_MS) {
        outcome.set(entry.sessionId, { ...entry, since: chat.lastActivityAt })
      } else if (
        (await this.deps.busy(bot, entry.sessionId)) ||
        !(await this.deps.close(entry.sessionId))
      ) {
        outcome.set(entry.sessionId, { ...entry, since: this.deps.now() })
      } else {
        outcome.set(entry.sessionId, null)
      }
    }
    if (outcome.size > 0) {
      // Re-read: a run that finished during the sweep armed its own entry.
      this.save(
        this.all().flatMap((entry) => {
          const next = outcome.get(entry.sessionId)
          return next === undefined ? [entry] : next ? [next] : []
        })
      )
    }
  }

  private nextDeadline(): number | null {
    const bots = new Map(this.deps.bots().map((bot) => [bot.id, bot]))
    let next: number | null = null
    for (const entry of this.all()) {
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

  private all(): Entry[] {
    const path = this.deps.path()
    if (this.entries?.path !== path) {
      let list: Entry[] = []
      try {
        const text = this.deps.read(path)
        list = text ? FileSchema.parse(JSON.parse(text)).chats : []
      } catch (error) {
        // Unreadable: those chats stay open, as before this existed.
        console.warn('[bots] finished run chat list unreadable; starting it again', error)
      }
      this.entries = { path, list }
    }
    return this.entries.list
  }

  private save(list: Entry[]): void {
    const path = this.deps.path()
    this.entries = { path, list }
    try {
      this.deps.write(path, JSON.stringify({ chats: list }))
    } catch (error) {
      console.warn('[bots] could not save the finished run chat list', error)
    }
  }
}
