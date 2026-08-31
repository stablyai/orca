import type { AmphetamineUnavailableReason } from '../shared/computer-awake-mode'
import { AmphetamineAvailability } from './macos-amphetamine-availability'
import { AmphetamineFailureBackoff } from './macos-amphetamine-failure-backoff'
import { AmphetamineReconcileTimer } from './macos-amphetamine-reconcile-timer'
import {
  AMPHETAMINE_SESSION_STATUS_SCRIPT,
  classifyAmphetamineFailure,
  parseAmphetamineSessionStatus,
  runOsascriptWithRunProcess,
  type OsascriptResult,
  type RunOsascript
} from './macos-amphetamine-session'

export const MACOS_AMPHETAMINE_OBSERVATION_RETRY_MS = 30_000
export const MACOS_AMPHETAMINE_RECONCILE_MS = 30_000

type Logger = Pick<Console, 'debug' | 'warn'>

type MacosAmphetamineSessionObserverOptions = {
  logger?: Logger
  now?: () => number
  onUnexpectedFailure?: (reason: string) => void
  onUnavailable?: (reason: AmphetamineUnavailableReason) => void
  onStateChanged?: () => void
  platform?: NodeJS.Platform
  reconcileMs?: number
  runOsascript?: RunOsascript
}

/**
 * Observes Amphetamine's global session without ever writing to it.
 *
 * The scripting API has no session identity or atomic compare-and-swap. Both
 * start and end can therefore destroy a session another actor created between
 * Apple events. Read-only observation is the only deterministic non-destructive policy.
 */
export class MacosAmphetamineSessionObserver {
  private readonly logger: Logger
  private readonly onStateChanged: () => void
  private readonly onUnavailable: (reason: AmphetamineUnavailableReason) => void
  private readonly onUnexpectedFailure: (reason: string) => void
  private readonly platform: NodeJS.Platform
  private readonly reconcileMs: number
  private readonly runOsascript: RunOsascript
  private readonly availability = new AmphetamineAvailability()
  private readonly backoff: AmphetamineFailureBackoff
  private readonly reconcileTimer = new AmphetamineReconcileTimer()
  private active = false
  private desired = false
  private disposed = false
  private generation = 0
  private observationAbort: AbortController | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(options: MacosAmphetamineSessionObserverOptions = {}) {
    this.logger = options.logger ?? console
    this.onStateChanged = options.onStateChanged ?? (() => {})
    this.onUnavailable = options.onUnavailable ?? (() => {})
    this.onUnexpectedFailure = options.onUnexpectedFailure ?? (() => {})
    this.platform = options.platform ?? process.platform
    this.reconcileMs = options.reconcileMs ?? MACOS_AMPHETAMINE_RECONCILE_MS
    this.runOsascript = options.runOsascript ?? runOsascriptWithRunProcess
    this.backoff = new AmphetamineFailureBackoff({
      logger: this.logger,
      now: options.now ?? Date.now,
      retryMs: MACOS_AMPHETAMINE_OBSERVATION_RETRY_MS,
      onRetryDue: () => {
        if (this.canObserve(this.generation)) {
          this.enqueue('macos-amphetamine-observation-retry', this.generation)
        }
      }
    })
  }

  start(reason: string): void {
    if (
      this.platform !== 'darwin' ||
      this.disposed ||
      this.desired ||
      this.availability.isUnavailable()
    ) {
      return
    }
    this.desired = true
    this.generation += 1
    this.startReconcileTimer()
    this.enqueue(reason, this.generation)
  }

  stop(_reason: string): void {
    if (this.platform !== 'darwin' || this.disposed) {
      return
    }
    this.desired = false
    this.generation += 1
    this.observationAbort?.abort()
    this.observationAbort = null
    this.stopReconcileTimer()
    this.backoff.reset()
    this.setActive(false)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.desired = false
    this.generation += 1
    this.observationAbort?.abort()
    this.observationAbort = null
    this.stopReconcileTimer()
    this.backoff.reset()
    this.active = false
  }

  clearUnavailable(): void {
    if (!this.disposed) {
      this.availability.clear()
      this.backoff.reset()
    }
  }

  isUnavailable(): boolean {
    return this.availability.isUnavailable()
  }

  getUnavailableReason(): AmphetamineUnavailableReason | null {
    return this.availability.get()
  }

  isActive(): boolean {
    return this.active
  }

  private enqueue(reason: string, generation: number): void {
    this.queue = this.queue.then(() => this.observe(reason, generation)).catch(() => {})
  }

  private async observe(reason: string, generation: number): Promise<void> {
    if (!this.canObserve(generation) || this.backoff.isSuppressed()) {
      return
    }
    const abort = new AbortController()
    this.observationAbort = abort
    let result: OsascriptResult
    try {
      result = await this.runOsascript(AMPHETAMINE_SESSION_STATUS_SCRIPT, abort.signal)
    } catch (error) {
      if (this.observationAbort === abort) {
        this.observationAbort = null
      }
      if (this.canObserve(generation)) {
        this.reportTransientFailure('status-spawn-error', reason, error)
      }
      return
    }
    if (this.observationAbort === abort) {
      this.observationAbort = null
    }
    if (!this.canObserve(generation)) {
      return
    }
    if (result.timedOut) {
      this.reportTransientFailure('status:timeout', reason, { stderr: result.stderr.trim() })
      return
    }
    if (result.code !== 0) {
      const unavailable = classifyAmphetamineFailure(result)
      if (unavailable) {
        this.markUnavailable(unavailable, reason, result)
      } else {
        this.reportTransientFailure(`status:${String(result.code)}`, reason, {
          stderr: result.stderr.trim(),
          timedOut: result.timedOut
        })
      }
      return
    }
    const status = parseAmphetamineSessionStatus(result.stdout)
    if (!status) {
      this.reportTransientFailure('status:unparseable', reason, { stdout: result.stdout.trim() })
      return
    }
    this.backoff.reset()
    this.startReconcileTimer()
    this.setActive(status === 'active')
  }

  private reportTransientFailure(failureKey: string, reason: string, details: unknown): void {
    this.setActive(false)
    this.stopReconcileTimer()
    this.backoff.record(failureKey, reason, details)
    this.onUnexpectedFailure('macos-amphetamine-observation-failure')
  }

  private markUnavailable(
    unavailableReason: AmphetamineUnavailableReason,
    reason: string,
    details: unknown
  ): void {
    const isNewVerdict = this.availability.mark(unavailableReason)
    this.desired = false
    this.generation += 1
    this.stopReconcileTimer()
    this.backoff.reset()
    this.setActive(false)
    if (!isNewVerdict) {
      return
    }
    this.logger.warn('[agent-awake] Amphetamine is unavailable', {
      reason,
      unavailableReason,
      details
    })
    this.onUnavailable(unavailableReason)
  }

  private canObserve(generation: number): boolean {
    return !this.disposed && this.desired && this.generation === generation
  }

  private setActive(active: boolean): void {
    if (this.active === active) {
      return
    }
    this.active = active
    if (!this.disposed) {
      this.onStateChanged()
    }
  }

  private startReconcileTimer(): void {
    this.reconcileTimer.start(this.reconcileMs, () => {
      if (this.canObserve(this.generation)) {
        this.enqueue('amphetamine-reconcile', this.generation)
      }
    })
  }

  private stopReconcileTimer(): void {
    this.reconcileTimer.stop()
  }
}
