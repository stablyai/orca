// Closes the chats automation runs open as a new conversation each time, once each has sat idle for
// its bot's Close after. One timer for the nearest deadline; the list survives a restart.
import type { Bot } from '../../shared/bot-types'
import {
  botRunChatCloseAfterMs,
  type BotRunChatCloseAfter
} from '../../shared/bots/bot-run-chat-close'
import { RunChatList, type Entry, type Line, type RunChatListFile } from './bot-run-chat-close-list'

const MAX_TIMER_DELAY_MS = 2_147_483_647
// A sweep that failed (chat records unavailable) waits an hour, doubling to a day.
const FAILED_SWEEP_RETRY_MS = 60 * 60 * 1000
const MAX_FAILED_SWEEP_RETRY_MS = 24 * 60 * 60 * 1000
// Chats due this close together share one sweep.
const SWEEP_COALESCE_MS = 10 * 60 * 1000

/** One of the bot's chats as the closer sees it now; null when it is gone or closed. */
export type BotRunChatState = {
  lastActivityAt: number
  /** Home Chats, chats linked to a thread and chats run elsewhere never close on their own. */
  kept: boolean
  /** Open on a screen or in a tab, or not checkable right now: not now, checked again later. */
  inUse: boolean
}

/** This host's list, one change per line; the last line for a chat wins. */
export type BotRunChatCloseDeps = RunChatListFile & {
  now: () => number
  bots: () => readonly Bot[]
  hostDefault: () => BotRunChatCloseAfter
  /** Throws while chat records can't be read, so a sweep then never mistakes a chat for gone. */
  ready: () => Promise<void>
  /** Reads this one chat's record. */
  chat: (bot: Bot, sessionId: string) => BotRunChatState | null
  /** The chats automations run in, read once per sweep. */
  automationChats: () => ReadonlySet<string>
  /** Busy: a turn or a usage-limit wait, or an automation that runs in it; `item`: it owns an open
   *  item. Null when neither. */
  busy: (
    bot: Bot,
    sessionId: string,
    automationChats: ReadonlySet<string>
  ) => Promise<'busy' | 'item' | null>
  /** The chat's /clear root, which the list is keyed by. */
  rootOf: (sessionId: string) => string
  /** It asked another bot, here or on a paired computer, and the answer hasn't come back, or mail
   *  for it is still on its way. Read in the close's own lane too, so none lands on a closed chat. */
  owesReply: (sessionId: string) => boolean
  /** Closes it once `admit` agrees in the session's own lane, and only while it is idle. */
  close: (sessionId: string, admit: () => boolean) => Promise<boolean>
}

export class BotRunChatCloser {
  private readonly list: RunChatList
  private failedAt: number | null = null
  private failures = 0
  // A parked chat sets no timer once checked this launch: what holds it wakes it when it ends.
  private readonly checkedThisLaunch = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerAt: number | undefined
  private windows = ''
  // Every read and write of the list runs here, one at a time.
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: BotRunChatCloseDeps) {
    this.list = new RunChatList(deps)
  }

  /** A run's own conversation just finished: its countdown starts now. A bot on Never tracks none. */
  arm(bot: Bot, sessionId: string): void {
    const ms = this.closeAfterMs(bot)
    if (ms === null) {
      return
    }
    const entry: Entry = { sessionId, botId: bot.id, since: this.deps.now() }
    void this.serial(async () => {
      await this.list.save([entry])
      this.moveTimerEarlier(entry.since + ms)
    })
  }

  /** What held these chats open ended (a turn, a viewer leaving): each parked one counts down again. */
  wake(sessionIds: readonly string[]): void {
    void this.serial(async () => {
      const byChat = await this.list.load()
      const roots = new Set(sessionIds.flatMap((id) => [id, this.deps.rootOf(id)]))
      await this.unpark([...roots].flatMap((id) => byChat.get(id) ?? []))
    })
  }

  /** These bots' items changed, so an item holding one of their parked chats may have closed. */
  itemsChanged(botIds: readonly string[]): void {
    void this.serial(async () => {
      const byChat = await this.list.load()
      const parked = botIds.flatMap((botId) => this.list.heldByItemsOf(botId))
      await this.unpark(parked.flatMap((id) => byChat.get(id) ?? []))
    })
  }

  /** A deleted bot's chats are no longer this closer's. */
  forget(botId: string): void {
    void this.serial(async () => {
      const byChat = await this.list.load()
      const removed = [...byChat.values()].filter((entry) => entry.botId === botId)
      removed.forEach(({ sessionId }) => this.checkedThisLaunch.delete(sessionId))
      await this.list.save(removed.map(({ sessionId }) => ({ sessionId, removed: true as const })))
      await this.rearmNow()
    })
  }

  private async unpark(entries: readonly Entry[]): Promise<void> {
    const now = this.deps.now()
    const woken = entries.flatMap(({ sessionId, botId, parked }) =>
      parked ? [{ sessionId, botId, since: now }] : []
    )
    woken.forEach(({ sessionId }) => this.checkedThisLaunch.delete(sessionId))
    await this.list.save(woken)
    for (const entry of woken) {
      const bot = this.deps.bots().find((candidate) => candidate.id === entry.botId)
      const ms = bot ? this.closeAfterMs(bot) : null
      if (ms !== null) {
        this.moveTimerEarlier(entry.since + ms)
      }
    }
  }

  // Only ever earlier: a later deadline is already covered by the timer's own rearm.
  private moveTimerEarlier(at: number): void {
    if (this.timerAt === undefined || at < this.timerAt) {
      this.setTimer(at)
    }
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
    const byChat = await this.list.load()
    const bots = new Map(this.deps.bots().map((bot) => [bot.id, bot]))
    const due = [...byChat.values()].flatMap((entry) => {
      const bot = this.waitsForWake(entry) ? undefined : bots.get(entry.botId)
      const ms = bot ? this.closeAfterMs(bot) : null
      return bot && ms !== null && entry.since + ms <= now + SWEEP_COALESCE_MS
        ? [{ entry, bot }]
        : []
    })
    if (due.length === 0) {
      return
    }
    await this.deps.ready()
    const automationChats = this.deps.automationChats()
    const changes: Line[] = []
    for (const { entry, bot } of due) {
      // One chat whose reads keep failing waits for a wake, and never holds up the others.
      const next = await this.settle(entry, bot, now, automationChats).catch((error: unknown) => {
        console.warn('[bots] could not check a finished run chat', error)
        return this.parked(entry, true)
      })
      if (!next?.parked) {
        this.checkedThisLaunch.delete(entry.sessionId)
      }
      changes.push(next ?? { sessionId: entry.sessionId, removed: true })
    }
    await this.list.save(changes)
  }

  /** What stays of a due entry: null once the chat closed or isn't one to close, else a later start. */
  private async settle(
    entry: Entry,
    bot: Bot,
    now: number,
    automationChats: ReadonlySet<string>
  ): Promise<Entry | null> {
    const waiting = (): Entry | 'due' | null => {
      const chat = this.deps.chat(bot, entry.sessionId)
      if (!chat || chat.kept) {
        return null
      }
      if (chat.inUse) {
        return this.parked(entry, true)
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
    // Each of these ends on its own: the chat is parked until what ends it wakes it.
    if (this.deps.owesReply(entry.sessionId)) {
      return this.parked(entry, true)
    }
    const busy = await this.deps.busy(bot, entry.sessionId, automationChats)
    if (busy) {
      return this.parked(entry, busy === 'item' ? 'item' : true)
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
    return after === 'due' ? this.parked(entry, true) : after
  }

  private parked(entry: Entry, parked: NonNullable<Entry['parked']>): Entry {
    this.checkedThisLaunch.add(entry.sessionId)
    return { sessionId: entry.sessionId, botId: entry.botId, since: this.deps.now(), parked }
  }

  /** Parked and already checked this launch: only what ends its hold brings it back. */
  private waitsForWake(entry: Entry): boolean {
    return entry.parked !== undefined && this.checkedThisLaunch.has(entry.sessionId)
  }

  /** When the timer fires next; undefined while nothing sets it. */
  nextSweepAt(): number | undefined {
    return this.timerAt
  }

  private async rearmNow(): Promise<void> {
    this.windows = this.windowsKey()
    const next = this.nextDeadline(await this.list.load())
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

  private nextDeadline(byChat: ReadonlyMap<string, Entry>): number | null {
    const bots = new Map(this.deps.bots().map((bot) => [bot.id, bot]))
    let next: number | null = null
    for (const entry of byChat.values()) {
      const bot = bots.get(entry.botId)
      // A bot this profile doesn't have keeps its chats for the profile that does.
      const ms = bot && !this.waitsForWake(entry) ? this.closeAfterMs(bot) : null
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
}
