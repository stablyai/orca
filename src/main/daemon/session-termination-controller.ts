import { PhysicalExitTracker } from '../../shared/physical-exit-tracker'
import type { SubprocessHandle } from './session-subprocess-handle'
import {
  IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS,
  SESSION_FORCE_KILL_RETRY_MS
} from './immediate-kill-reply-budget'

const KILL_TIMEOUT_MS = 5_000
export { IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS, SESSION_FORCE_KILL_RETRY_MS }
const SESSION_FORCE_KILL_MAX_ATTEMPTS = 2

export type SessionTerminationControllerDeps = {
  sessionId: string
  subprocess: SubprocessHandle
  isExited(): boolean
  releaseProducerPause(opts: { resume: boolean }): void
}

export class SessionTerminationController {
  private _isTerminating = false
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private forceKillSent = false
  private subprocessDisposed = false
  private readonly physicalExit = new PhysicalExitTracker()

  constructor(private readonly deps: SessionTerminationControllerDeps) {}

  get isTerminating(): boolean {
    return this._isTerminating
  }

  markPhysicalExit(): void {
    this.physicalExit.markExited()
  }

  clearTerminating(): void {
    this._isTerminating = false
  }

  /** Claim synchronously before async teardown; false means exited or already claimed. */
  beginTermination(): boolean {
    if (this.deps.isExited() || this._isTerminating) {
      return false
    }
    this._isTerminating = true
    // Resume a child blocked on write before snapshotting so it can process termination.
    this.deps.releaseProducerPause({ resume: true })
    return true
  }

  signalTerminationRoot(): void {
    if (this.deps.isExited()) {
      return
    }
    try {
      this.deps.subprocess.kill()
    } catch (error) {
      // Signal rejection does not prove exit; release the claim so later attempts can retry.
      this.resetTerminationAfterSignalFailure()
      throw error
    }
  }

  /** Arm escalation when a coordinator already owns the snapshot-first teardown. */
  scheduleForceDisposeFallback(): void {
    if (this.killTimer) {
      return
    }
    this.armForceKillFallback(KILL_TIMEOUT_MS, SESSION_FORCE_KILL_MAX_ATTEMPTS)
  }

  cancelForceKillFallback(): void {
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
  }

  async forceKillAndWaitForExit(
    timeoutMs = IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS
  ): Promise<void> {
    if (this.deps.isExited()) {
      return
    }
    if (!this._isTerminating) {
      this._isTerminating = true
      this.deps.releaseProducerPause({ resume: true })
    }
    // Escalate now rather than spend the physical-exit budget waiting for graceful shutdown.
    await this.requestForceKillWithRetry()
    await this.waitForPhysicalExit(timeoutMs)
  }

  signal(sig: string): void {
    if (this.deps.isExited()) {
      return
    }
    this.deps.subprocess.signal(sig)
  }

  disposeSubprocessHandle(): void {
    if (this.subprocessDisposed) {
      return
    }
    this.subprocessDisposed = true
    try {
      this.deps.subprocess.dispose()
    } catch (err) {
      // Native-handle failures must not interrupt client and host-map cleanup.
      console.warn('[Session] subprocess.dispose() threw:', err)
    }
  }

  private resetTerminationAfterSignalFailure(): void {
    this._isTerminating = false
    this.cancelForceKillFallback()
  }

  private armForceKillFallback(delayMs: number, attemptsRemaining: number): void {
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      if (!this.deps.isExited()) {
        try {
          this.requestForceKill()
        } catch (error) {
          console.warn('[Session] failed to force-kill terminating subprocess:', error)
          // A transient force-kill rejection must not consume the only fallback attempt.
          if (attemptsRemaining > 1) {
            this.armForceKillFallback(SESSION_FORCE_KILL_RETRY_MS, attemptsRemaining - 1)
          }
        }
      }
    }, delayMs)
  }

  private requestForceKill(): void {
    if (this.deps.isExited() || this.forceKillSent) {
      return
    }
    this.forceKillSent = true
    try {
      this.deps.subprocess.forceKill()
    } catch (error) {
      this.forceKillSent = false
      throw error
    }
  }

  private async requestForceKillWithRetry(): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < SESSION_FORCE_KILL_MAX_ATTEMPTS; attempt++) {
      try {
        this.requestForceKill()
        return
      } catch (error) {
        lastError = error
      }
      if (attempt + 1 < SESSION_FORCE_KILL_MAX_ATTEMPTS) {
        try {
          await this.physicalExit.waitForExit(
            SESSION_FORCE_KILL_RETRY_MS,
            () => new Error(`Retrying force-kill for PTY ${this.deps.sessionId}`)
          )
          return
        } catch {}
      }
    }
    throw lastError
  }

  private waitForPhysicalExit(timeoutMs: number): Promise<void> {
    // Detach timed-out waiters so repeated retries cannot retain them until an unkillable child exits.
    return this.physicalExit.waitForExit(
      timeoutMs,
      () => new Error(`Timed out waiting for PTY process exit: ${this.deps.sessionId}`)
    )
  }
}
