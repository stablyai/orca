import { relayLogLine } from './relay-diagnostic-log'

export type PtyOwnershipCaptureIngressLease = Readonly<{
  isCurrent: () => boolean
  release: () => void
}>

/** Late output invalidates capture rather than moving bytes into a second queue. */
export class PtyOwnershipCaptureIngressFence {
  private active?: { valid: boolean; timer: ReturnType<typeof setTimeout> }
  private disposed = false

  constructor(
    private readonly pause: () => void,
    private readonly resume: () => void
  ) {}

  get held(): boolean {
    return this.active !== undefined
  }

  begin(isAuthorized: () => boolean, timeoutMs = 5_000): PtyOwnershipCaptureIngressLease {
    if (
      this.disposed ||
      this.active ||
      !isAuthorized() ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30_000
    ) {
      throw new Error('pty_ownership_transfer_capture_ingress_unavailable')
    }
    const state = {
      valid: true,
      timer: setTimeout(() => {
        try {
          release()
        } catch {
          relayLogLine('pty_ownership_capture_expiry_resume_failed')
        }
      }, timeoutMs)
    }
    state.timer.unref?.()
    const release = () => {
      if (this.active !== state) {
        return
      }
      clearTimeout(state.timer)
      state.valid = false
      this.active = undefined
      this.resume()
    }
    this.active = state
    try {
      this.pause()
    } catch (error) {
      try {
        release()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'pty_ownership_capture_pause_cleanup_failed'
        )
      }
      throw error
    }
    return Object.freeze({
      isCurrent: () => {
        if (this.active !== state || !state.valid) {
          return false
        }
        try {
          if (!isAuthorized()) {
            state.valid = false
          }
        } catch {
          state.valid = false
        }
        return state.valid
      },
      release
    })
  }

  observeEmission(): void {
    if (this.active) {
      this.active.valid = false
    }
  }

  dispose(): void {
    this.disposed = true
    if (!this.active) {
      return
    }
    clearTimeout(this.active.timer)
    this.active.valid = false
    this.active = undefined
  }
}
