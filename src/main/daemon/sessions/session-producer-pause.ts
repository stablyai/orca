import type { SubprocessHandle } from './session-subprocess-handle'
import {
  isUntypedTerminalInput,
  isTerminalPointerReportOnly
} from '../../../shared/terminal/input/terminal-untyped-input'

/** 'input': typed input waited 2 s behind the pause; 'timeout': the 60 s no-progress deadline passed;
 *  'released': a detach, an attach or a failed termination, so the owner may pause afresh;
 *  'terminating': termination began, so the owner stops asking until 'released' or 'exited';
 *  'exited': exit or teardown dropped it, and this incarnation will never produce again. */
export type StreamStallReason = 'input' | 'timeout' | 'released' | 'terminating' | 'exited'
export type ProducerLifecycleReason = 'released' | 'terminating' | 'exited'
/** Why a stream pause was not taken: the producer is going away, gone, or has no viewer until an attach reports 'released'. */
export type ProducerAnswer = 'terminating' | 'exited' | 'detached'
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
  // The last stream owner's handler, kept past release so lifecycle changes always reach it.
  private streamOwner: StreamStallHandler | null = null

  constructor(private readonly subprocess: Pick<SubprocessHandle, 'pause' | 'resume'>) {}

  /** Client pauses refresh the lost-resume failsafe; stream pauses use their own stall watchdog. False when a stream pause was declined. */
  pause(
    source?: 'stream',
    canPauseStream: true | 'terminating' | 'detached' = true,
    onStreamStall?: (reason: StreamStallReason) => void
  ): true | 'terminating' | 'detached' {
    if (source === 'stream') {
      this.streamOwner = onStreamStall ?? this.streamOwner
      if (canPauseStream !== true) {
        return canPauseStream
      }
      this.onStreamStall = onStreamStall ?? null
      this.setStreamBackpressured(true)
      return true
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

  /** A reason tells the stream owner about the producer's lifecycle, whether or not a pause was held. */
  release(opts: { resume: boolean; reason?: ProducerLifecycleReason }): void {
    if (this.failsafeTimer) {
      clearTimeout(this.failsafeTimer)
      this.failsafeTimer = null
    }
    this.clearStreamStallWatchdog()
    if (this.paused || this.streamBackpressured) {
      this.paused = false
      this.streamBackpressured = false
      if (opts.resume) {
        this.subprocess.resume?.()
      }
    }
    if (opts.reason) {
      this.report(opts.reason)
    }
  }

  /** A first viewer can consume again, so a stream owner that skipped this viewerless producer may pause it. */
  noteViewerAttached(firstViewer: boolean): void {
    if (firstViewer) {
      this.report('released')
    }
  }

  /** Tells the last stream owner about a lifecycle change without touching any pause. */
  private report(reason: ProducerLifecycleReason): void {
    this.streamOwner?.(reason)
    if (reason === 'exited') {
      this.streamOwner = null
    }
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
