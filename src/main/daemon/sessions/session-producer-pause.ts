import type { SubprocessHandle } from './session-subprocess-handle'
import {
  isUntypedTerminalInput,
  isTerminalPointerReportOnly
} from '../../../shared/terminal/input/terminal-untyped-input'

/** 'input' when typed input shortened the watchdog, so the stall owner can tell the two apart. */
export type StreamStallReason = 'input' | 'timeout'

// A dropped resume notification must not wedge a shell; a still-flooded client can pause it again.
export const PRODUCER_PAUSE_FAILSAFE_MS = 5_000

// Bound half-open consumer stalls; shed backlog before resuming the live producer.
export const STREAM_BACKPRESSURE_STALL_WATCHDOG_MS = 60_000
// Typed input behind a paused stream must reach the program soon; the input watchdog only resumes, never sheds.
export const STREAM_STALL_WITH_INPUT_WATCHDOG_MS = 2_000

export class SessionProducerPause {
  private paused = false
  private streamBackpressured = false
  private failsafeTimer: ReturnType<typeof setTimeout> | null = null
  private streamStallTimer: ReturnType<typeof setTimeout> | null = null
  private streamStallDeadline = 0
  private streamStallReason: StreamStallReason = 'timeout'
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

  /** Typed input while stream-paused shortens the stall watchdog; replies and pointer reports don't, and it never lengthens. */
  noteInput(data: string): void {
    if (
      this.streamStallTimer &&
      this.streamStallDeadline - Date.now() > STREAM_STALL_WITH_INPUT_WATCHDOG_MS &&
      !isUntypedTerminalInput(data) &&
      !isTerminalPointerReportOnly(data)
    ) {
      clearTimeout(this.streamStallTimer)
      this.armStreamStallWatchdog(STREAM_STALL_WITH_INPUT_WATCHDOG_MS, 'input')
    }
  }

  private armStreamStallWatchdog(
    delayMs = STREAM_BACKPRESSURE_STALL_WATCHDOG_MS,
    reason: StreamStallReason = 'timeout'
  ): void {
    const onStreamStall = this.onStreamStall
    if (!onStreamStall) {
      return
    }
    this.streamStallDeadline = Date.now() + delayMs
    this.streamStallReason = reason
    this.streamStallTimer = setTimeout(() => {
      this.streamStallTimer = null
      // Shed backlog before resuming; losing the consumer does not imply child exit.
      onStreamStall(this.streamStallReason)
      this.setStreamBackpressured(false)
    }, delayMs)
  }

  private clearStreamStallWatchdog(): void {
    if (this.streamStallTimer) {
      clearTimeout(this.streamStallTimer)
      this.streamStallTimer = null
    }
    this.onStreamStall = null
  }
}
