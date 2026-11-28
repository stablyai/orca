import type { SubprocessHandle } from './session-subprocess-handle'
import {
  isUntypedTerminalInput,
  isTerminalPointerReportOnly
} from '../../../shared/terminal/input/terminal-untyped-input'

/** 'input': typed input waited 2 s behind the pause; 'timeout': the 60 s no-progress deadline passed;
 *  'released': a detach dropped the pause, so the owner pauses afresh after a reattach. */
export type StreamStallReason = 'input' | 'timeout' | 'released'
export type StreamStallHandler = (reason: StreamStallReason) => void

// A dropped resume notification must not wedge a shell; a still-flooded client can pause it again.
export const PRODUCER_PAUSE_FAILSAFE_MS = 5_000

// Bound half-open consumer stalls; shed backlog before resuming the live producer.
export const STREAM_BACKPRESSURE_STALL_WATCHDOG_MS = 60_000
// Typed input behind a paused stream asks the stall owner to resume within 2 s; it never moves the 60 s deadline.
export const STREAM_STALL_WITH_INPUT_WATCHDOG_MS = 2_000

export class SessionProducerPause {
  private paused = false
  private streamBackpressured = false
  private failsafeTimer: ReturnType<typeof setTimeout> | null = null
  private streamStallTimer: ReturnType<typeof setTimeout> | null = null
  private inputStallTimer: ReturnType<typeof setTimeout> | null = null
  private onStreamStall: ((reason: StreamStallReason) => void) | null = null

  constructor(private readonly subprocess: Pick<SubprocessHandle, 'pause' | 'resume'>) {}

  /** Client pauses refresh the lost-resume failsafe; stream pauses use their own stall watchdog. False when a stream pause was declined. */
  pause(
    source?: 'stream',
    canPauseStream = true,
    onStreamStall?: (reason: StreamStallReason) => void
  ): boolean {
    if (source === 'stream') {
      if (canPauseStream) {
        this.onStreamStall = onStreamStall ?? null
        this.setStreamBackpressured(true)
      }
      return canPauseStream
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
    return true
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

  /** `detached` tells the stream owner its pause is gone; exit and teardown don't, since that owner hears of exit itself. */
  release(opts: { resume: boolean; detached?: boolean }): void {
    if (this.failsafeTimer) {
      clearTimeout(this.failsafeTimer)
      this.failsafeTimer = null
    }
    const onStreamStall = opts.detached && this.streamBackpressured ? this.onStreamStall : null
    this.clearStreamStallWatchdog()
    if (!this.paused && !this.streamBackpressured) {
      return
    }
    this.paused = false
    this.streamBackpressured = false
    if (opts.resume) {
      this.subprocess.resume?.()
    }
    onStreamStall?.('released')
  }

  /** Typed input while stream-paused asks the stall owner to resume in 2 s; replies and pointer reports don't. */
  noteInput(data: string): void {
    const onStreamStall = this.onStreamStall
    if (
      !onStreamStall ||
      !this.streamStallTimer ||
      this.inputStallTimer ||
      isUntypedTerminalInput(data) ||
      isTerminalPointerReportOnly(data)
    ) {
      return
    }
    this.inputStallTimer = setTimeout(() => {
      this.inputStallTimer = null
      // The owner resumes only a draining consumer; the 60 s deadline keeps running either way.
      onStreamStall('input')
    }, STREAM_STALL_WITH_INPUT_WATCHDOG_MS)
  }

  private armStreamStallWatchdog(): void {
    // Each timer keeps the handler it was armed with, so a later pause can't redirect it.
    const onStreamStall = this.onStreamStall
    if (!onStreamStall) {
      return
    }
    this.streamStallTimer = setTimeout(() => {
      this.streamStallTimer = null
      // Shed backlog before resuming; losing the consumer does not imply child exit.
      onStreamStall('timeout')
      this.setStreamBackpressured(false)
    }, STREAM_BACKPRESSURE_STALL_WATCHDOG_MS)
  }

  private clearStreamStallWatchdog(): void {
    for (const timer of [this.streamStallTimer, this.inputStallTimer]) {
      if (timer) {
        clearTimeout(timer)
      }
    }
    this.streamStallTimer = null
    this.inputStallTimer = null
    this.onStreamStall = null
  }
}
