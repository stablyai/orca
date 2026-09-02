import { killWithDescendantSweep } from '../pty-descendant-termination'
import { PhysicalExitTracker } from '../../shared/physical-exit-tracker'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TuiAgent } from '../../shared/tui-agent'

const KILL_TIMEOUT_MS = 5_000
export const IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS = 8_000
export const SESSION_FORCE_KILL_RETRY_MS = 250
const SESSION_FORCE_KILL_MAX_ATTEMPTS = 2

export type SessionTerminationControllerDeps = {
  sessionId: string
  subprocess: SubprocessHandle
  launchAgent: TuiAgent | null
  isExited(): boolean
  releaseProducerPause(opts: { resume: boolean }): void
}

/** Owns a session's termination claim and every escalation past it: graceful signal, the bounded
 *  force-kill fallback, and the one-shot release of the native PTY handle. */
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

  /** Claims termination synchronously so attach/re-entry cannot race async
   * teardown preparation. Returns false when another owner already claimed it. */
  beginTermination(): boolean {
    if (this.deps.isExited() || this._isTerminating) {
      return false
    }
    this._isTerminating = true
    // Why: a paused child can be blocked inside write(); resume before any async snapshot so it handles termination promptly.
    this.deps.releaseProducerPause({ resume: true })
    return true
  }

  kill(): void {
    if (!this.beginTermination()) {
      return
    }
    if (!this.deps.launchAgent) {
      this.signalTerminationRoot()
    } else {
      // Why: agent tool children live in detached process groups a dying shell's SIGHUP never reaches, so sweep them.
      void Promise.resolve(
        killWithDescendantSweep(
          this.deps.subprocess.pid,
          () => {
            this.signalTerminationRoot()
          },
          {
            // Why: if the root exits during ps its PID can be recycled; never apply that stale snapshot to a different process tree.
            ownsRoot: () => !this.deps.isExited(),
            terminateOwnedTree: () => this.deps.subprocess.terminateOwnedTree()
          }
        )
      ).catch((error) => {
        if (!this.deps.isExited()) {
          this.resetTerminationAfterSignalFailure()
        }
        console.warn('[Session] descendant-aware graceful kill failed:', error)
      })
    }
    this.scheduleForceDisposeFallback()
  }

  /** Signals a root whose descendant snapshot has completed. */
  signalTerminationRoot(): void {
    if (this.deps.isExited()) {
      return
    }
    try {
      this.deps.subprocess.kill()
    } catch (error) {
      // Why: a rejected signal is not termination; reopen the session so a later retry can still target the live child.
      this.resetTerminationAfterSignalFailure()
      throw error
    }
  }

  /** Starts the graceful-kill deadline when a coordinator owns the snapshot-first portion of teardown. */
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
    // Why: escalate a graceful termination now; waiting for the 5s timer would spend most of the physical-exit budget.
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
      // Why: dispose() should never throw, but if it does, callers must still complete their own cleanup (fanout, map removal).
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
          // Why: a transient SIGKILL rejection must not consume the only fallback owner after graceful shutdown returned.
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
        } catch {
          // The bounded waiter detached; retry the still-owned subprocess.
        }
      }
    }
    throw lastError
  }

  private waitForPhysicalExit(timeoutMs: number): Promise<void> {
    // Why: timed-out destructive retries must detach from an unkillable child, else each retry stays retained until it exits.
    return this.physicalExit.waitForExit(
      timeoutMs,
      () => new Error(`Timed out waiting for PTY process exit: ${this.deps.sessionId}`)
    )
  }
}
