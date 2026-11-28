import { PhysicalExitTracker } from '../../../shared/process-observation/physical-exit-tracker'
import type { SubprocessHandle } from './session-subprocess-handle'
import {
  IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS,
  SESSION_FORCE_KILL_RETRY_MS
} from './immediate-kill-reply-budget'

const KILL_TIMEOUT_MS = 5_000
const SESSION_FORCE_KILL_MAX_ATTEMPTS = 2

export type SessionTerminationControllerDeps = {
  sessionId: string
  subprocess: Pick<SubprocessHandle, 'kill' | 'forceKill' | 'signal' | 'dispose'>
  isExited(): boolean
  releaseProducerPause(opts: { resume: boolean; reason: 'released' | 'terminating' }): void
}

export class SessionTerminationController {
  private _isTerminating = false
  // Termination gave up on a live child: it still reserves the id, but its producer may be paused again.
  private gaveUp = false
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private forceKillRequest: Promise<void> | null = null
  private subprocessDisposed = false
  private readonly physicalExit = new PhysicalExitTracker()

  constructor(private readonly deps: SessionTerminationControllerDeps) {}

  get physicalCompletion(): Promise<void> {
    return this.physicalExit.exitedPromise
  }

  get isTerminating(): boolean {
    return this._isTerminating
  }

  /** How a stream pause request is answered: terminating blocks it unless termination gave up; no viewer declines it. */
  streamPauseAnswer(hasViewer: boolean): true | 'terminating' | 'detached' {
    if (this.blocksProducerPause) {
      return 'terminating'
    }
    return hasViewer || 'detached'
  }

  private get blocksProducerPause(): boolean {
    return this._isTerminating && !this.gaveUp
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
    this.claimProducer()
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
    if (!this.blocksProducerPause) {
      this.claimProducer()
    }
    // Escalate now rather than spend the physical-exit budget waiting for graceful shutdown.
    await this.requestForceKillWithRetry().catch((error: unknown) => {
      this.giveUpProducer()
      throw error
    })
    try {
      await this.waitForPhysicalExit(timeoutMs)
    } catch (error) {
      // A fulfilled request without exit cannot suppress the next explicit cleanup attempt.
      this.forceKillRequest = null
      throw error
    }
  }

  signal(sig: string): void {
    if (this.deps.isExited()) {
      return
    }
    this.deps.subprocess.signal(sig)
  }

  /** Joins any in-flight request so disposal never starts a second process-group sweep. */
  forceKillDuringDispose(): Promise<void> {
    return this.requestForceKill()
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

  private claimProducer(): void {
    this._isTerminating = true
    this.gaveUp = false
    // Resume a child blocked on write before snapshotting so it can process termination.
    this.deps.releaseProducerPause({ resume: true, reason: 'terminating' })
  }

  /** Every force-kill attempt was refused; the child lives on, so its stream owner may pause it again. */
  private giveUpProducer(): void {
    if (!this.gaveUp && this._isTerminating && !this.deps.isExited()) {
      this.gaveUp = true
      this.deps.releaseProducerPause({ resume: false, reason: 'released' })
    }
  }

  private resetTerminationAfterSignalFailure(): void {
    this._isTerminating = false
    this.cancelForceKillFallback()
    // The producer lives on; let its stream owner pause it again.
    this.deps.releaseProducerPause({ resume: false, reason: 'released' })
  }

  private armForceKillFallback(delayMs: number, attemptsRemaining: number): void {
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      if (!this.deps.isExited()) {
        this.requestForceKill().catch((error: unknown) => {
          console.warn('[Session] failed to force-kill terminating subprocess:', error)
          // A transient force-kill rejection must not consume the only fallback attempt.
          if (attemptsRemaining > 1) {
            this.armForceKillFallback(SESSION_FORCE_KILL_RETRY_MS, attemptsRemaining - 1)
          } else {
            this.giveUpProducer()
          }
        })
      }
    }, delayMs)
  }

  /** Joiners await the in-flight request so their exit budget starts after signals are sent. */
  private requestForceKill(): Promise<void> {
    if (this.deps.isExited()) {
      return Promise.resolve()
    }
    if (!this.forceKillRequest) {
      const request = this.sendForceKill()
      this.forceKillRequest = request
      // A refused signal releases the claim so a retry can send again.
      request.catch(() => {
        if (this.forceKillRequest === request) {
          this.forceKillRequest = null
        }
      })
    }
    return this.forceKillRequest
  }

  private async sendForceKill(): Promise<void> {
    await this.deps.subprocess.forceKill()
  }

  private async requestForceKillWithRetry(): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < SESSION_FORCE_KILL_MAX_ATTEMPTS; attempt++) {
      try {
        await this.requestForceKill()
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
