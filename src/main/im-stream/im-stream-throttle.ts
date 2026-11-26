// One IM message edited in place: at most one write per gap, the newest frame replaces any still
// waiting, and no write starts while the previous one is unanswered (platforms ack each in order).
export const IM_STREAM_MIN_GAP_MS = 1000

/** The gap: `ORCA_IM_STREAM_MIN_GAP_MS` when set to 250 ms through 60 s, else one second. */
export function imStreamGapMs(env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env.ORCA_IM_STREAM_MIN_GAP_MS)
  return Number.isFinite(set) && set >= 250 && set <= 60_000 ? set : IM_STREAM_MIN_GAP_MS
}

export type ImStreamTimer = (run: () => void, ms: number) => () => void

/** setTimeout that never holds the process open. */
export const imStreamTimer: ImStreamTimer = (run, ms) => {
  const handle = setTimeout(run, ms)
  handle.unref?.()
  return () => clearTimeout(handle)
}

export class ImStreamThrottle<T> {
  private waiting: { frame: T } | null = null
  private writing: Promise<void> | null = null
  private lastStart = Number.NEGATIVE_INFINITY
  private cancelTimer: (() => void) | null = null
  private closed = false
  private readonly gapMs: number
  private readonly now: () => number
  private readonly timer: ImStreamTimer
  readonly counts = { written: 0, replaced: 0, failed: 0 }

  constructor(
    private readonly write: (frame: T) => Promise<void>,
    private readonly onFailure: (error: unknown) => void,
    options: { gapMs?: number; now?: () => number; timer?: ImStreamTimer } = {}
  ) {
    this.gapMs = options.gapMs ?? imStreamGapMs()
    this.now = options.now ?? Date.now
    this.timer = options.timer ?? imStreamTimer
  }

  /** Best effort: a frame still waiting when a newer one arrives is never written. */
  offer(frame: T): void {
    if (this.closed) {
      return
    }
    if (this.waiting) {
      this.counts.replaced++
    }
    this.waiting = { frame }
    this.pump()
  }

  /** The last frame, written after the gap and after any write in flight; rejects if it fails. */
  async finish(frame: T): Promise<void> {
    this.closed = true
    this.waiting = null
    this.cancelTimer?.()
    this.cancelTimer = null
    await this.writing
    const wait = this.lastStart + this.gapMs - this.now()
    if (wait > 0) {
      await new Promise<void>((resolve) => this.timer(resolve, wait))
    }
    this.lastStart = this.now()
    await this.write(frame)
    this.counts.written++
  }

  /** Drops what waits; a write in flight still completes. */
  async close(): Promise<void> {
    this.closed = true
    this.waiting = null
    this.cancelTimer?.()
    this.cancelTimer = null
    await this.writing
  }

  private pump(): void {
    if (this.closed || this.writing || this.cancelTimer || !this.waiting) {
      return
    }
    const wait = this.lastStart + this.gapMs - this.now()
    if (wait > 0) {
      this.cancelTimer = this.timer(() => {
        this.cancelTimer = null
        this.pump()
      }, wait)
      return
    }
    const { frame } = this.waiting
    this.waiting = null
    this.lastStart = this.now()
    this.writing = this.write(frame)
      .then(
        () => {
          this.counts.written++
        },
        (error: unknown) => {
          this.counts.failed++
          this.onFailure(error)
        }
      )
      .finally(() => {
        this.writing = null
        this.pump()
      })
  }
}
