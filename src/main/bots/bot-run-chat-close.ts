// Closes the chats automation runs open as a new conversation each time, once each has sat idle for
// its bot's Close after. One timer for the nearest deadline; the list survives a restart.
import { z } from 'zod'
import type { Bot } from '../../shared/bot-types'
import {
  botRunChatCloseAfterMs,
  type BotRunChatCloseAfter
} from '../../shared/bots/bot-run-chat-close'

const MAX_TIMER_DELAY_MS = 2_147_483_647
// The list is rewritten once its lines (changes appended since the last rewrite) pass this many per
// tracked chat, so writes stay proportional to changes.
const COMPACT_LINES_PER_CHAT = 2
const COMPACT_MIN_LINES = 1000
// A sweep that failed (chat records unavailable) waits an hour, doubling to a day.
const FAILED_SWEEP_RETRY_MS = 60 * 60 * 1000
const MAX_FAILED_SWEEP_RETRY_MS = 24 * 60 * 60 * 1000
// Chats due this close together share one sweep.
const SWEEP_COALESCE_MS = 10 * 60 * 1000

const EntrySchema = z.object({
  sessionId: z.string().min(1),
  botId: z.string().min(1),
  /** When its countdown last started: the run's end, or the last time it was busy or active. */
  since: z.number(),
  /** Held open by something that ends on its own (a tab, an item, an answer): it sets no timer and is
   *  checked again in the next sweep another chat starts, or once after a restart. */
  parked: z.literal(true).optional()
})
type Entry = z.infer<typeof EntrySchema>
// A later line that takes a chat off the list.
const RemovedSchema = z.object({ sessionId: z.string().min(1), removed: z.literal(true) })

/** One of the bot's chats as the closer sees it now; null when it is gone or closed. */
export type BotRunChatState = {
  lastActivityAt: number
  /** Home Chats, chats linked to a thread and chats run elsewhere never close on their own. */
  kept: boolean
  /** Open on a screen or in a tab, or not checkable right now: not now, checked again later. */
  inUse: boolean
}

export type BotRunChatCloseDeps = {
  /** This host's list, one change per line; the last line for a chat wins. */
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
  /** Busy: a turn or a usage-limit wait, an open item it owns, or an automation that runs in it. */
  busy: (bot: Bot, sessionId: string) => Promise<boolean>
  /** It asked another bot, here or on a paired computer, and the answer hasn't come back, or mail
   *  for it is still on its way. Read in the close's own lane too, so none lands on a closed chat. */
  owesReply: (sessionId: string) => boolean
  /** Closes it once `admit` agrees in the session's own lane, and only while it is idle. */
  close: (sessionId: string, admit: () => boolean) => Promise<boolean>
}

export class BotRunChatCloser {
  private entries: { path: string; byChat: Map<string, Entry>; lines: number } | null = null
  private failedAt: number | null = null
  private failures = 0
  // Parked chats wait for a sweep, except once per launch, so a held chat never wakes an idle Orca.
  private sweptThisLaunch = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerAt: number | undefined
  private windows = ''
  // Every read and write of the list runs here, one at a time.
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: BotRunChatCloseDeps) {}

  /** A run's own conversation just finished: its countdown starts now. A bot on Never tracks none. */
  arm(bot: Bot, sessionId: string): void {
    const ms = this.closeAfterMs(bot)
    if (ms === null) {
      return
    }
    const entry: Entry = { sessionId, botId: bot.id, since: this.deps.now() }
    void this.serial(async () => {
      const byChat = await this.all()
      byChat.delete(sessionId)
      byChat.set(sessionId, entry)
      await this.save([entry])
      // Only ever earlier: a later deadline is already covered by the timer's own rearm.
      if (this.timerAt === undefined || entry.since + ms < this.timerAt) {
        this.setTimer(entry.since + ms)
      }
    })
  }

  /** A deleted bot's chats are no longer this closer's. */
  forget(botId: string): void {
    void this.serial(async () => {
      const byChat = await this.all()
      const removed = [...byChat.values()].filter((entry) => entry.botId === botId)
      removed.forEach((entry) => byChat.delete(entry.sessionId))
      await this.save(removed.map(({ sessionId }) => ({ sessionId, removed: true as const })))
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
        this.sweptThisLaunch = true
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
    const changes: Line[] = []
    for (const { entry, bot } of due) {
      const next = await this.settle(entry, bot, now)
      if (next) {
        byChat.set(entry.sessionId, next)
        changes.push(next)
      } else {
        byChat.delete(entry.sessionId)
        changes.push({ sessionId: entry.sessionId, removed: true })
      }
    }
    await this.save(changes)
  }

  /** What stays of a due entry: null once the chat closed or isn't one to close, else a later start. */
  private async settle(entry: Entry, bot: Bot, now: number): Promise<Entry | null> {
    const waiting = (): Entry | 'due' | null => {
      const chat = this.deps.chat(bot, entry.sessionId)
      if (!chat || chat.kept) {
        return null
      }
      if (chat.inUse) {
        return this.parked(entry)
      }
      // Re-read each time: Close after can change while the checks run.
      const current = this.deps.bots().find((candidate) => candidate.id === bot.id)
      const ms = current ? this.closeAfterMs(current) : null
      const since = Math.max(entry.since, chat.lastActivityAt)
      const { sessionId, botId } = entry
      return ms === null || since + ms > now + SWEEP_COALESCE_MS
        ? { sessionId, botId, since }
        : 'due'
    }
    const first = waiting()
    if (first !== 'due') {
      return first
    }
    // Each of these can end, so the chat is checked again a whole Close after from now.
    if (this.deps.owesReply(entry.sessionId) || (await this.deps.busy(bot, entry.sessionId))) {
      return this.parked(entry)
    }
    // A turn, a wake, a question, an open tab or a new Close after may come up to the close itself.
    const closed = await this.deps.close(
      entry.sessionId,
      () => waiting() === 'due' && !this.deps.owesReply(entry.sessionId)
    )
    if (closed) {
      return null
    }
    const after = waiting()
    return after === 'due' ? this.parked(entry) : after
  }

  private parked(entry: Entry): Entry {
    return { sessionId: entry.sessionId, botId: entry.botId, since: this.deps.now(), parked: true }
  }

  /** When the timer fires next; undefined while nothing sets it. */
  nextSweepAt(): number | undefined {
    return this.timerAt
  }

  private async rearmNow(): Promise<void> {
    this.windows = this.windowsKey()
    const next = this.nextDeadline(await this.all())
    if (this.timer && this.timerAt === next) {
      return
    }
    this.clear()
    if (next !== null) {
      this.setTimer(next)
    }
  }

  private setTimer(next: number): void {
    this.clear()
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
      const ms = bot && !(entry.parked && this.sweptThisLaunch) ? this.closeAfterMs(bot) : null
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
      let lines = 0
      for (const line of text?.split('\n') ?? []) {
        const parsed = parseLine(line)
        if (!parsed) {
          continue
        }
        lines += 1
        byChat.delete(parsed.sessionId)
        if (!('removed' in parsed)) {
          byChat.set(parsed.sessionId, parsed)
        }
      }
      this.entries = { path, byChat, lines }
    }
    return this.entries.byChat
  }

  /** Appends the changes, or rewrites the list once the appended lines outgrow it. */
  private async save(changes: readonly Line[]): Promise<void> {
    if (changes.length === 0) {
      return
    }
    const byChat = await this.all()
    const entries = this.entries
    if (!entries) {
      return
    }
    const path = this.deps.path()
    try {
      const lines = entries.lines + changes.length
      if (lines > Math.max(COMPACT_MIN_LINES, byChat.size * COMPACT_LINES_PER_CHAT)) {
        await this.deps.write(path, [...byChat.values()].map(lineText).join(''))
        entries.lines = byChat.size
      } else {
        await this.deps.append(path, changes.map(lineText).join(''))
        entries.lines = lines
      }
    } catch (error) {
      console.warn('[bots] could not save the finished run chat list', error)
    }
  }
}

type Line = Entry | z.infer<typeof RemovedSchema>

// Leading newline: a line a crash cut short never swallows the next one.
function lineText(line: Line): string {
  return `\n${JSON.stringify(line)}`
}

// An unreadable line leaves that chat as it was, so at worst it stays open.
function parseLine(line: string): Line | null {
  if (!line.trim()) {
    return null
  }
  try {
    const json: unknown = JSON.parse(line)
    const removed = RemovedSchema.safeParse(json)
    if (removed.success) {
      return removed.data
    }
    const entry = EntrySchema.safeParse(json)
    return entry.success ? entry.data : null
  } catch {
    return null
  }
}
