// A watched chat's journal moves with every streamed token; it is settled once it pauses.
const SETTLE_AFTER_MS = 2_000

/** When reply recovery settles each chat again: soon after its journal pauses, and at a hold's
 *  durable deadline (or a retry), so a hold ends with nothing else moving. */
export class ReplySettleTimers {
  private readonly soon = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly settle: (sessionId: string) => void,
    private readonly now: () => number
  ) {}

  /** Settles the chat once its journal has paused for a moment. */
  later(sessionId: string): void {
    clearTimeout(this.soon.get(sessionId))
    const timer = setTimeout(() => {
      this.soon.delete(sessionId)
      this.settle(sessionId)
    }, SETTLE_AFTER_MS)
    timer.unref?.()
    this.soon.set(sessionId, timer)
  }

  /** Settles the chat again at `at` (replacing any earlier deadline); null clears it. */
  deadline(sessionId: string, at: number | null): void {
    clearTimeout(this.deadlines.get(sessionId))
    this.deadlines.delete(sessionId)
    if (at === null) {
      return
    }
    const timer = setTimeout(
      () => {
        this.deadlines.delete(sessionId)
        this.settle(sessionId)
      },
      Math.max(0, at - this.now())
    )
    timer.unref?.()
    this.deadlines.set(sessionId, timer)
  }

  clear(): void {
    for (const timers of [this.soon, this.deadlines]) {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }
}
