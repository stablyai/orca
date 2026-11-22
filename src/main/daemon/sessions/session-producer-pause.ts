import type { SubprocessHandle } from './session-subprocess-handle'

// A dropped resume notification must not wedge a shell; a still-flooded client can pause it again.
export const PRODUCER_PAUSE_FAILSAFE_MS = 5_000

// Bound half-open consumer stalls; shed backlog before resuming the live producer.
export const STREAM_BACKPRESSURE_STALL_WATCHDOG_MS = 60_000

export class SessionProducerPause {
  private paused = false
  private streamBackpressured = false
  private failsafeTimer: ReturnType<typeof setTimeout> | null = null
  private streamStallTimer: ReturnType<typeof setTimeout> | null = null
  private onStreamStall: (() => void) | null = null

  constructor(private readonly subprocess: Pick<SubprocessHandle, 'pause' | 'resume'>) {}

  /** Client pauses refresh the lost-resume failsafe; stream pauses use their own stall watchdog. */
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
      // Repeated enqueues from a busy sibling must not postpone this session’s stall watchdog.
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
      // Shed backlog before resuming; losing the consumer does not imply child exit.
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
