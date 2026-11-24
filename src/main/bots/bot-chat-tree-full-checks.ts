// When the chat-tree index checks a bot against a build from every record: never on a read, only while
// the host is idle, one bot at a time, each at most every 15 min, sooner after a store or database swap.
// One timer, armed for the next bot due; it fires no more often than bots fall due.

/** A full check of one bot, at most this often, and only while the host is idle. */
const FULL_CHECK_INTERVAL_MS = 15 * 60_000
/** How long the host must have told of no change before a check runs. */
const FULL_CHECK_QUIET_MS = 60_000
/** A check slower than this pushes that bot's next one further out. */
const FULL_CHECK_BUDGET_MS = 100
const FULL_CHECK_MAX_INTERVAL_MS = 4 * 60 * 60_000

export type BotChatTreeFullCheckDeps = {
  /** Whether the host is quiet (nothing streaming); absent, no check ever runs on its own. */
  idle?: () => boolean
  now: () => number
  /** Runs one bot's check; returns how long it took. */
  verify: (botId: string) => number
}

export class BotChatTreeFullChecks {
  private readonly schedule = new Map<string, { checkedAt: number; everyMs: number }>()
  /** One timer, for the next bot due; none while nothing is. */
  private timer: { at: number; handle: ReturnType<typeof setTimeout> } | null = null
  private lastChangeAt = 0

  constructor(private readonly deps: BotChatTreeFullCheckDeps) {}

  /** A bot the index now keeps; its first check is one interval out. */
  track(botId: string): void {
    if (!this.schedule.has(botId)) {
      this.schedule.set(botId, { checkedAt: this.deps.now(), everyMs: FULL_CHECK_INTERVAL_MS })
      this.arm()
    }
  }

  forget(botId: string): void {
    this.schedule.delete(botId)
  }

  /** A change went out; checks wait for a quiet minute after it. */
  noteChange(): void {
    this.lastChangeAt = this.deps.now()
    this.arm()
  }

  /** A store or database swap: every bot is due once the host is quiet. */
  dueAll(): void {
    for (const entry of this.schedule.values()) {
      entry.checkedAt = 0
    }
    this.arm()
  }

  /** A check ran: the next is one interval out, further when this one ran over its budget. */
  private checked(botId: string, ms: number): void {
    const entry = this.schedule.get(botId)
    if (entry) {
      entry.checkedAt = this.deps.now()
      entry.everyMs =
        ms > FULL_CHECK_BUDGET_MS
          ? Math.min(entry.everyMs * 2, FULL_CHECK_MAX_INTERVAL_MS)
          : FULL_CHECK_INTERVAL_MS
    }
  }

  /** The earliest a bot is due and the host has been quiet a minute; null when no bot is kept. */
  private nextAt(): number | null {
    let due: number | null = null
    for (const entry of this.schedule.values()) {
      const at = entry.checkedAt + entry.everyMs
      due = due === null ? at : Math.min(due, at)
    }
    return due === null ? null : Math.max(due, this.lastChangeAt + FULL_CHECK_QUIET_MS)
  }

  private arm(): void {
    const at = this.nextAt()
    if (at === null || !this.deps.idle || (this.timer && this.timer.at <= at)) {
      return
    }
    if (this.timer) {
      clearTimeout(this.timer.handle)
    }
    const handle = setTimeout(
      () => {
        this.timer = null
        this.fire()
      },
      Math.max(0, at - this.deps.now())
    )
    handle.unref?.()
    this.timer = { at, handle }
  }

  /** One due bot, only while idle; a busy host's next change arms the timer again. */
  private fire(): void {
    const now = this.deps.now()
    if (now - this.lastChangeAt < FULL_CHECK_QUIET_MS) {
      this.arm()
      return
    }
    if (!this.deps.idle?.()) {
      return
    }
    let due: [string, { checkedAt: number; everyMs: number }] | undefined
    for (const candidate of this.schedule) {
      const [, entry] = candidate
      if (now - entry.checkedAt >= entry.everyMs && (!due || entry.checkedAt < due[1].checkedAt)) {
        due = candidate
      }
    }
    if (due) {
      this.checked(due[0], this.deps.verify(due[0]))
    }
    this.arm()
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer.handle)
      this.timer = null
    }
    this.schedule.clear()
  }
}
