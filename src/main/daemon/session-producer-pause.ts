import type { SubprocessHandle } from './session-subprocess-handle'

// Why: pause is a fire-and-forget notify, so a resume can be lost (main crash, dropped socket); a lost
// resume must never wedge a shell, so auto-resume after this window — a still-flooded main re-pauses.
export const PRODUCER_PAUSE_FAILSAFE_MS = 5_000

/** Producer-side flow control for one session's PTY fd, with the lost-resume failsafe. */
export class SessionProducerPause {
  private paused = false
  private failsafeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly subprocess: Pick<SubprocessHandle, 'pause' | 'resume'>) {}

  /** Stop reading the PTY fd so a flooding child blocks on write. Arms the failsafe; re-pausing re-arms it. */
  pause(): void {
    this.paused = true
    this.subprocess.pause?.()
    if (this.failsafeTimer) {
      clearTimeout(this.failsafeTimer)
    }
    this.failsafeTimer = setTimeout(() => {
      this.failsafeTimer = null
      this.paused = false
      this.subprocess.resume?.()
    }, PRODUCER_PAUSE_FAILSAFE_MS)
  }

  release(opts: { resume: boolean }): void {
    if (this.failsafeTimer) {
      clearTimeout(this.failsafeTimer)
      this.failsafeTimer = null
    }
    if (!this.paused) {
      return
    }
    this.paused = false
    if (opts.resume) {
      this.subprocess.resume?.()
    }
  }
}
