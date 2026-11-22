// Closes a bot side chat once every item it drove is done or canceled and nothing in it still runs:
// after a countdown every device shows, paused while a desktop has it open or holds an unsent message,
// skipped once the owner keeps it open for that set of items. Each chat's steps run one at a time.
import {
  BOT_CHAT_AUTO_CLOSE_HOLD_LEASE_MS,
  BOT_CHAT_AUTO_CLOSE_MS,
  botChatAutoCloseKey,
  botChatCloseBlocker,
  botChatItemStamp,
  type BotChatAutoCloseView,
  type BotChatCloseFacts
} from '../../shared/bots/bot-chat-auto-close'
import type { BotChatAutoCloseMarks } from './bot-chat-auto-close-marks'

/** A turn's end is read once its status has settled, so the chat no longer reads as replying. */
export const BOT_CHAT_TURN_END_SETTLE_MS = 2_000

export type BotChatAutoCloseDeps = {
  now: () => number
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Null when the bot has no such chat or it can't be read: it stays as it is. */
  facts: (botId: string, chatId: string) => Promise<BotChatCloseFacts | null>
  /** The bot's chats that drove any item. */
  chatsWithItems: (botId: string) => Promise<readonly string[]>
  botIds: () => readonly string[]
  /** `orca`: the countdown ran out, so the chat says why; `owner`: Close now. */
  close: (botId: string, chatId: string, by: 'orca' | 'owner') => Promise<void>
  /** Shows the same chat's tab again, so it reads and takes mail as before. */
  reopen: (botId: string, chatId: string) => Promise<void>
  marks: BotChatAutoCloseMarks
  /** Clients re-read the bot's chats. */
  changed: (botId: string) => void
}

type Phase =
  | { phase: 'counting'; closesAt: number; timer: unknown }
  | { phase: 'held' }
  | { phase: 'kept' }

const warn = (error: unknown): void => console.warn('[bots] chat auto-close', error)

export class BotChatAutoClose {
  private readonly phases = new Map<string, Phase>()
  /** Each chat's holders (a desktop window) and when their hold lapses. */
  private readonly holds = new Map<string, Map<string, number>>()
  private readonly holdTimers = new Map<string, unknown>()
  private readonly lanes = new Map<string, Promise<void>>()

  constructor(private readonly deps: BotChatAutoCloseDeps) {}

  view(botId: string, chatId: string): BotChatAutoCloseView | null {
    const phase = this.phases.get(botChatAutoCloseKey(botId, chatId))
    if (!phase) {
      return null
    }
    return phase.phase === 'counting'
      ? { phase: 'counting', closesAt: phase.closesAt }
      : { phase: phase.phase }
  }

  /** When Orca closed the chat, while it stays closed. */
  autoClosedAt(botId: string, chatId: string): number | null {
    return this.deps.marks.closedAt(botChatAutoCloseKey(botId, chatId))
  }

  /** Arms the countdown when the chat is quiet with every item closed; never closes at once. */
  evaluate(botId: string, chatId: string): Promise<void> {
    return this.lane(botId, chatId, () => this.settle(botId, chatId, false))
  }

  /** A turn ended: read the chat once its status settles. */
  turnEnded(botId: string, chatId: string): void {
    this.deps.setTimer(() => void this.evaluate(botId, chatId), BOT_CHAT_TURN_END_SETTLE_MS)
  }

  /** A message reached the chat: anything counting stops, and a chat Orca closed opens again. */
  turnStarted(botId: string, chatId: string): Promise<void> {
    return this.lane(botId, chatId, async () => {
      const key = botChatAutoCloseKey(botId, chatId)
      this.drop(key, botId)
      if (this.deps.marks.closedAt(key) !== null) {
        await this.reopenNow(botId, chatId)
      }
    })
  }

  /** A change notice covering items (any kind when unnamed) for these bots (all when unnamed), from
   *  any source: each chat that drove an item is read again. */
  async itemsChanged(scope: {
    botIds?: readonly string[]
    kinds?: readonly string[]
  }): Promise<void> {
    if (scope.kinds && !scope.kinds.includes('items')) {
      return
    }
    const botIds = scope.botIds ?? this.deps.botIds()
    await Promise.all(botIds.map((botId) => this.evaluateBot(botId)))
  }

  /** After a start: every countdown begins again from the full time. */
  async boot(): Promise<void> {
    await this.deps.marks.ready()
    const botIds = this.deps.botIds()
    // Rows read "Closed by Orca" once the marks are read.
    botIds.forEach((botId) => this.deps.changed(botId))
    await Promise.all(botIds.map((botId) => this.evaluateBot(botId)))
  }

  private async evaluateBot(botId: string): Promise<void> {
    const chats = await this.deps.chatsWithItems(botId).catch((error: unknown) => {
      warn(error)
      return []
    })
    await Promise.all(chats.map((chatId) => this.evaluate(botId, chatId)))
  }

  /** A desktop has the chat open or an unsent message in it (`on`), or no longer does. */
  hold(botId: string, chatId: string, holder: string, on: boolean): Promise<void> {
    const key = botChatAutoCloseKey(botId, chatId)
    const holders = this.holds.get(key) ?? new Map<string, number>()
    if (on) {
      holders.set(holder, this.deps.now() + BOT_CHAT_AUTO_CLOSE_HOLD_LEASE_MS)
      this.holds.set(key, holders)
      this.watchHolds(botId, chatId)
    } else {
      holders.delete(holder)
      if (holders.size === 0) {
        this.holds.delete(key)
      }
    }
    const phase = this.phases.get(key)?.phase
    // Holding pauses a countdown; the last hold ending starts it again.
    return (on && phase === 'counting') || (!on && phase === 'held' && !this.isHeld(key))
      ? this.evaluate(botId, chatId)
      : Promise.resolve()
  }

  /** Keep open, from any device, for the chat's items as they are now. */
  keepOpen(botId: string, chatId: string): Promise<void> {
    return this.lane(botId, chatId, async () => {
      const facts = await this.deps.facts(botId, chatId)
      if (!facts || botChatCloseBlocker(facts)) {
        return
      }
      const key = botChatAutoCloseKey(botId, chatId)
      this.deps.marks.setKept(key, botChatItemStamp(facts.items))
      this.set(key, botId, { phase: 'kept' })
    })
  }

  /** Close now: the owner's own close, so it reads as theirs. */
  closeNow(botId: string, chatId: string): Promise<void> {
    return this.lane(botId, chatId, async () => {
      const key = botChatAutoCloseKey(botId, chatId)
      if (!this.phases.has(key)) {
        return
      }
      this.drop(key, botId)
      await this.deps.close(botId, chatId, 'owner')
    })
  }

  /** The owner reopened a chat Orca closed: the same chat, kept open for its items as they are. */
  reopen(botId: string, chatId: string): Promise<void> {
    return this.lane(botId, chatId, () => this.reopenNow(botId, chatId))
  }

  dispose(): void {
    for (const phase of this.phases.values()) {
      if (phase.phase === 'counting') {
        this.deps.clearTimer(phase.timer)
      }
    }
    for (const timer of this.holdTimers.values()) {
      this.deps.clearTimer(timer)
    }
    this.phases.clear()
    this.holds.clear()
    this.holdTimers.clear()
  }

  private async reopenNow(botId: string, chatId: string): Promise<void> {
    const key = botChatAutoCloseKey(botId, chatId)
    const facts = await this.deps.facts(botId, chatId)
    // Kept in the same write that clears the close, so the next read can't re-arm it.
    this.deps.marks.reopened(key, facts ? botChatItemStamp(facts.items) : '')
    await this.deps.reopen(botId, chatId)
    this.deps.changed(botId)
  }

  private async settle(botId: string, chatId: string, firing: boolean): Promise<void> {
    const key = botChatAutoCloseKey(botId, chatId)
    const facts = await this.deps.facts(botId, chatId)
    if (!facts) {
      return
    }
    const blocker = botChatCloseBlocker(facts)
    if (blocker !== 'closed' && this.deps.marks.closedAt(key) !== null) {
      // Opened again some other way: treat it as reopened, so it doesn't close again on its own.
      this.deps.marks.reopened(key, botChatItemStamp(facts.items))
      this.drop(key, botId)
      return
    }
    if (blocker) {
      this.drop(key, botId)
      return
    }
    const stamp = botChatItemStamp(facts.items)
    const kept = this.deps.marks.keptStamp(key)
    if (kept === stamp) {
      this.set(key, botId, { phase: 'kept' })
      return
    }
    if (kept !== null) {
      // Kept for an earlier set of items; new work has finished since.
      this.deps.marks.setKept(key, null)
    }
    if (this.isHeld(key)) {
      this.set(key, botId, { phase: 'held' })
      return
    }
    const current = this.phases.get(key)
    if (!firing) {
      if (current?.phase !== 'counting') {
        this.arm(key, botId, chatId)
      }
      return
    }
    // A timer may run a moment early; the deadline is what every device shows.
    if (current?.phase !== 'counting' || current.closesAt > this.deps.now() + 1_000) {
      return
    }
    this.drop(key, botId)
    this.deps.marks.setClosed(key, this.deps.now())
    await this.deps.close(botId, chatId, 'orca')
    this.deps.changed(botId)
  }

  private arm(key: string, botId: string, chatId: string): void {
    const closesAt = this.deps.now() + BOT_CHAT_AUTO_CLOSE_MS
    const timer = this.deps.setTimer(
      () => void this.lane(botId, chatId, () => this.settle(botId, chatId, true)),
      BOT_CHAT_AUTO_CLOSE_MS
    )
    this.set(key, botId, { phase: 'counting', closesAt, timer })
  }

  private set(key: string, botId: string, next: Phase): void {
    const current = this.phases.get(key)
    if (current?.phase === 'counting' && current !== next) {
      this.deps.clearTimer(current.timer)
    }
    this.phases.set(key, next)
    if (current?.phase !== next.phase || next.phase === 'counting') {
      this.deps.changed(botId)
    }
  }

  private drop(key: string, botId: string): void {
    const current = this.phases.get(key)
    if (!current) {
      return
    }
    if (current.phase === 'counting') {
      this.deps.clearTimer(current.timer)
    }
    this.phases.delete(key)
    this.deps.changed(botId)
  }

  private isHeld(key: string): boolean {
    const holders = this.holds.get(key)
    if (!holders) {
      return false
    }
    const now = this.deps.now()
    for (const [holder, until] of holders) {
      if (until <= now) {
        holders.delete(holder)
      }
    }
    if (holders.size === 0) {
      this.holds.delete(key)
      return false
    }
    return true
  }

  /** A desktop that stops renewing (closed, asleep) lets the countdown start again. */
  private watchHolds(botId: string, chatId: string): void {
    const key = botChatAutoCloseKey(botId, chatId)
    const existing = this.holdTimers.get(key)
    if (existing !== undefined) {
      this.deps.clearTimer(existing)
    }
    const timer = this.deps.setTimer(() => {
      this.holdTimers.delete(key)
      if (this.isHeld(key)) {
        this.watchHolds(botId, chatId)
      } else if (this.phases.get(key)?.phase === 'held') {
        void this.evaluate(botId, chatId)
      }
    }, BOT_CHAT_AUTO_CLOSE_HOLD_LEASE_MS)
    this.holdTimers.set(key, timer)
  }

  private lane(botId: string, chatId: string, step: () => Promise<void>): Promise<void> {
    const key = botChatAutoCloseKey(botId, chatId)
    // Marks are read from disk once; no step reads or writes them before that.
    const run = (this.lanes.get(key) ?? this.deps.marks.ready())
      .then(() => this.deps.marks.ready())
      .then(step)
      .catch(warn)
    this.lanes.set(key, run)
    void run.finally(() => {
      if (this.lanes.get(key) === run) {
        this.lanes.delete(key)
      }
    })
    return run
  }
}
