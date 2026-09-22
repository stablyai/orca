import type { SubprocessHandle } from './session-subprocess-handle'

// Why: pause is a fire-and-forget notify, so a resume can be lost (main crash, dropped socket); a lost
// resume must never wedge a shell, so auto-resume after this window — a still-flooded main re-pauses.
export const PRODUCER_PAUSE_FAILSAFE_MS = 5_000

// Why: a stream pause has no lost-resume problem (the batcher un-pauses from its own drain accounting),
// but it does have a stalled-consumer problem — a half-open peer (slept laptop, dropped NAT state)
// neither drains nor closes, so nothing ever calls back and the shell blocks on write() forever. Bound
// the stall; the owner's callback then sheds the backlog so the session runs again with a visible gap.
// 60s: far above any healthy drain (the shallow-socket gate turns over in milliseconds), so a slow but
// live consumer is never mistaken for a wedged one.
export const STREAM_BACKPRESSURE_STALL_WATCHDOG_MS = 60_000

/** Producer-side flow control for one session's PTY fd, with the lost-resume failsafe. */
export class SessionProducerPause {
  private paused = false
  private streamBackpressured = false
  private failsafeTimer: ReturnType<typeof setTimeout> | null = null
  private streamStallTimer: ReturnType<typeof setTimeout> | null = null
  private onStreamStall: (() => void) | null = null

  constructor(private readonly subprocess: Pick<SubprocessHandle, 'pause' | 'resume'>) {}

  /** Stop reading the PTY fd so a flooding child blocks on write. Arms the failsafe; re-pausing re-arms it. */
  pause(source?: 'stream', canPauseStream = true, onStreamStall?: () => void): void {
    if (source === 'stream') {
      if (canPauseStream) {
        this.onStreamStall = onStreamStall ?? null
        this.setStreamBackpressured(true)
      }
      return
    }
    const wasPaused = this.paused || this.streamBackpressured
    this.paused = true
    if (!wasPaused) {
      this.subprocess.pause?.()
    }
    if (this.failsafeTimer) {
      clearTimeout(this.failsafeTimer)
    }
    this.failsafeTimer = setTimeout(() => {
      this.failsafeTimer = null
      this.paused = false
      if (!this.streamBackpressured) {
        this.subprocess.resume?.()
      }
    }, PRODUCER_PAUSE_FAILSAFE_MS)
  }

  setStreamBackpressured(paused: boolean): void {
    const wasPaused = this.paused || this.streamBackpressured
    const wasStreamBackpressured = this.streamBackpressured
    this.streamBackpressured = paused
    if (paused) {
      // Only on the transition: refresh() re-asserts an already-standing pause on every enqueue for any
      // session sharing the client, and re-arming there would let a busy neighbour defer the watchdog forever.
      if (!wasStreamBackpressured) {
        this.armStreamStallWatchdog()
      }
    } else {
      this.clearStreamStallWatchdog()
    }
    const nowPaused = this.paused || this.streamBackpressured
    if (nowPaused && !wasPaused) {
      this.subprocess.pause?.()
    } else if (wasPaused && !nowPaused) {
      this.subprocess.resume?.()
    }
  }

  resumeClient(source?: 'stream'): void {
    if (source === 'stream') {
      this.setStreamBackpressured(false)
      return
    }
    if (this.failsafeTimer) {
      clearTimeout(this.failsafeTimer)
      this.failsafeTimer = null
    }
    const wasPaused = this.paused
    this.paused = false
    if (wasPaused && !this.streamBackpressured) {
      this.subprocess.resume?.()
    }
  }

  release(opts: { resume: boolean }): void {
    if (this.failsafeTimer) {
      clearTimeout(this.failsafeTimer)
      this.failsafeTimer = null
    }
    this.clearStreamStallWatchdog()
    if (!this.paused && !this.streamBackpressured) {
      return
    }
    this.paused = false
    this.streamBackpressured = false
    if (opts.resume) {
      this.subprocess.resume?.()
    }
  }

  private armStreamStallWatchdog(): void {
    const onStreamStall = this.onStreamStall
    if (!onStreamStall) {
      return
    }
    this.streamStallTimer = setTimeout(() => {
      this.streamStallTimer = null
      // Shed the backlog BEFORE resuming, so the producer never refills an unbounded queue. Loss of
      // contact with the consumer says nothing about the child process — nothing here reports an exit.
      onStreamStall()
      this.setStreamBackpressured(false)
    }, STREAM_BACKPRESSURE_STALL_WATCHDOG_MS)
  }

  private clearStreamStallWatchdog(): void {
    if (this.streamStallTimer) {
      clearTimeout(this.streamStallTimer)
      this.streamStallTimer = null
    }
    this.onStreamStall = null
  }
}
