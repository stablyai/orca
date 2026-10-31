import type { LoginPreflightOutcome } from '../providers/macos-tcc-login-shell'
import type { DaemonFileLog } from './daemon-file-log'
import {
  createLoginSessionWatchClock,
  type LoginSessionWatchClock
} from './login-session-watch-clock'
import {
  DEFAULT_LOGIN_SESSION_WATCH_TIMING,
  type LoginSessionWatchTiming
} from './login-session-watch-timing'
import type { SystemResolverHealth } from './types'

// Require repeated rejection as well as an elapsed observation window.
const REQUIRED_CONSECUTIVE_REJECTIONS = 3

export type MacosLoginSessionDeathWatchOptions = {
  /** Bypass the PAM cache; null means the login wrapper does not apply. */
  probeLoginSession: (signal?: AbortSignal) => Promise<LoginPreflightOutcome | null>
  readResolverHealth: (signal?: AbortSignal) => Promise<SystemResolverHealth>
  onRetire: (details: {
    cause: 'pam-rejections'
    rejections: number
    resolverHealth: SystemResolverHealth
  }) => void
  log: DaemonFileLog
  clock?: LoginSessionWatchClock
  timing?: Partial<LoginSessionWatchTiming>
}

/** Retire a previously valid GUI session only after sustained conclusive PAM rejection and explicit resolver failure. */
export class MacosLoginSessionDeathWatch {
  private readonly probeLoginSession: MacosLoginSessionDeathWatchOptions['probeLoginSession']
  private readonly readResolverHealth: MacosLoginSessionDeathWatchOptions['readResolverHealth']
  private readonly onRetire: MacosLoginSessionDeathWatchOptions['onRetire']
  private readonly log: DaemonFileLog
  private readonly clock: LoginSessionWatchClock
  private readonly periodicProbeMs: number
  private readonly rejectionRecheckMs: number
  private readonly minimumRejectionSpanMs: number
  private readonly ptyExitDebounceMs: number
  private readonly clientActivityMinGapMs: number
  private readonly minProbeGapMs: number

  // Only a previously successful login probe can establish a session worth watching.
  private armed = false
  private consecutiveRejections = 0
  private firstRejectionAtMs: number | null = null
  private lastProbeStartedAtMs: number | null = null
  private probeInFlight = false
  private stopped = false
  private retired = false
  private scheduledProbeTimer: unknown = null
  private scheduledProbeAtMs: number | null = null
  private ptyExitDebounceTimer: unknown = null
  private pendingProbeTrigger: string | null = null
  private probeAbortController: AbortController | null = null

  constructor(opts: MacosLoginSessionDeathWatchOptions) {
    this.probeLoginSession = opts.probeLoginSession
    this.readResolverHealth = opts.readResolverHealth
    this.onRetire = opts.onRetire
    this.log = opts.log
    this.clock = opts.clock ?? createLoginSessionWatchClock()
    const defaults = DEFAULT_LOGIN_SESSION_WATCH_TIMING
    this.periodicProbeMs = opts.timing?.periodicProbeMs ?? defaults.periodicProbeMs
    this.rejectionRecheckMs = opts.timing?.rejectionRecheckMs ?? defaults.rejectionRecheckMs
    this.minimumRejectionSpanMs =
      opts.timing?.minimumRejectionSpanMs ?? defaults.minimumRejectionSpanMs
    this.ptyExitDebounceMs = opts.timing?.ptyExitDebounceMs ?? defaults.ptyExitDebounceMs
    this.clientActivityMinGapMs =
      opts.timing?.clientActivityMinGapMs ?? defaults.clientActivityMinGapMs
    this.minProbeGapMs = opts.timing?.minProbeGapMs ?? defaults.minProbeGapMs
  }

  start(): void {
    if (this.stopped) {
      return
    }
    void this.runProbe('startup')
  }

  stop(): void {
    this.stopped = true
    this.probeAbortController?.abort()
    this.probeAbortController = null
    if (this.scheduledProbeTimer !== null) {
      this.clock.clearTimeout(this.scheduledProbeTimer)
      this.scheduledProbeTimer = null
      this.scheduledProbeAtMs = null
    }
    if (this.ptyExitDebounceTimer !== null) {
      this.clock.clearTimeout(this.ptyExitDebounceTimer)
      this.ptyExitDebounceTimer = null
    }
  }

  /** PTY exit bursts may signal logout, so debounce them into a probe. */
  notifyPtyExit(): void {
    if (this.stopped) {
      return
    }
    if (this.ptyExitDebounceTimer !== null) {
      this.clock.clearTimeout(this.ptyExitDebounceTimer)
    }
    this.ptyExitDebounceTimer = this.clock.setTimeout(() => {
      this.ptyExitDebounceTimer = null
      void this.runProbe('pty-exit')
    }, this.ptyExitDebounceMs)
  }

  notifyClientActivity(): void {
    if (this.stopped) {
      return
    }
    if (this.probeInFlight) {
      if (this.armed) {
        this.retainPendingProbe('client-hello')
      }
      return
    }
    const elapsedSinceProbe =
      this.lastProbeStartedAtMs === null ? null : this.clock.now() - this.lastProbeStartedAtMs
    if (elapsedSinceProbe !== null && elapsedSinceProbe < this.clientActivityMinGapMs) {
      // Retain post-login activity so recovery need not wait for the periodic backstop.
      this.scheduleProbeNoLaterThan(this.clientActivityMinGapMs - elapsedSinceProbe, 'client-hello')
      return
    }
    void this.runProbe('client-hello')
  }

  private scheduleProbe(delayMs: number, trigger: string): void {
    if (this.stopped) {
      return
    }
    if (this.scheduledProbeTimer !== null) {
      this.clock.clearTimeout(this.scheduledProbeTimer)
    }
    this.scheduledProbeAtMs = this.clock.now() + delayMs
    this.scheduledProbeTimer = this.clock.setTimeout(() => {
      const scheduledAtMs = this.scheduledProbeAtMs
      this.scheduledProbeTimer = null
      this.scheduledProbeAtMs = null
      void this.runProbe(trigger, scheduledAtMs ?? undefined)
    }, delayMs)
  }

  private scheduleNextProbe(delayMs: number): void {
    this.scheduleProbe(delayMs, 'periodic')
  }

  private scheduleProbeNoLaterThan(delayMs: number, trigger: string): void {
    const requestedAtMs = this.clock.now() + delayMs
    if (this.consecutiveRejections > 0 && this.scheduledProbeAtMs !== null) {
      return
    }
    if (this.scheduledProbeAtMs !== null && this.scheduledProbeAtMs <= requestedAtMs) {
      return
    }
    this.scheduleProbe(delayMs, trigger)
  }

  private probeGapMs(trigger: string): number {
    return trigger === 'client-hello' ? this.clientActivityMinGapMs : this.minProbeGapMs
  }

  private retainPendingProbe(trigger: string): void {
    if (
      this.pendingProbeTrigger === null ||
      this.probeGapMs(trigger) < this.probeGapMs(this.pendingProbeTrigger)
    ) {
      this.pendingProbeTrigger = trigger
    }
  }

  private async runProbe(trigger: string, scheduledAtMs?: number): Promise<void> {
    if (this.stopped || this.retired) {
      return
    }
    if (this.probeInFlight) {
      // The active probe may predate logout; retain one follow-up.
      this.retainPendingProbe(trigger)
      return
    }
    if (this.consecutiveRejections > 0 && scheduledAtMs === undefined) {
      return
    }
    const timerGapMs =
      scheduledAtMs === undefined ? 0 : Math.max(0, this.clock.now() - scheduledAtMs)
    let rejectionWindowRebased = false
    if (this.consecutiveRejections > 0 && timerGapMs > this.minProbeGapMs * 3) {
      // Sleep or App Nap pauses are not evidence of continued rejection.
      this.consecutiveRejections = 0
      this.firstRejectionAtMs = null
      rejectionWindowRebased = true
      this.log.log('login-session-rejection-window-reset', {
        cause: 'timer-gap',
        timerGapMs
      })
    }
    const elapsedSinceProbe =
      this.lastProbeStartedAtMs === null ? null : this.clock.now() - this.lastProbeStartedAtMs
    if (
      trigger !== 'startup' &&
      elapsedSinceProbe !== null &&
      elapsedSinceProbe < this.minProbeGapMs
    ) {
      this.scheduleProbeNoLaterThan(this.minProbeGapMs - elapsedSinceProbe, trigger)
      return
    }
    this.probeInFlight = true
    const probeStartedAtMs = this.clock.now()
    this.lastProbeStartedAtMs = probeStartedAtMs
    const abortController = new AbortController()
    this.probeAbortController = abortController
    try {
      const outcome = await this.probeLoginSession(abortController.signal)
      if (this.stopped || this.retired) {
        return
      }
      const probeGapMs = Math.max(0, this.clock.now() - probeStartedAtMs)
      if (this.consecutiveRejections > 0 && probeGapMs > this.minProbeGapMs * 3) {
        // Sleep may suspend a probe after the earlier timer-gap check.
        this.consecutiveRejections = 0
        this.firstRejectionAtMs = null
        rejectionWindowRebased = true
        this.log.log('login-session-rejection-window-reset', {
          cause: 'probe-gap',
          probeGapMs
        })
      }
      if (outcome === null) {
        // Without an applicable login wrapper, PAM cannot establish session health.
        this.log.log('login-session-watch-disabled', { trigger })
        this.stop()
        return
      }
      if (!outcome.conclusive) {
        // Repeated timeouts remain ambiguous and must never authorize retirement of live PTYs.
        this.scheduleNextProbe(this.periodicProbeMs)
        return
      }
      if (outcome.ok) {
        if (!this.armed) {
          this.log.log('login-session-watch-armed', { trigger })
        }
        this.armed = true
        this.consecutiveRejections = 0
        this.firstRejectionAtMs = null
        this.scheduleNextProbe(this.periodicProbeMs)
        return
      }
      if (!this.armed) {
        this.scheduleNextProbe(this.periodicProbeMs)
        return
      }
      this.firstRejectionAtMs ??= this.clock.now()
      this.consecutiveRejections++
      this.log.log('login-session-probe-rejected', {
        trigger,
        rejections: this.consecutiveRejections
      })
      if (this.consecutiveRejections < REQUIRED_CONSECUTIVE_REJECTIONS) {
        this.scheduleNextProbe(
          rejectionWindowRebased ? this.periodicProbeMs : this.rejectionRecheckMs
        )
        return
      }
      const rejectionSpanMs = this.clock.now() - this.firstRejectionAtMs
      if (rejectionSpanMs < this.minimumRejectionSpanMs) {
        const retryInMs = this.minimumRejectionSpanMs - rejectionSpanMs
        this.consecutiveRejections = REQUIRED_CONSECUTIVE_REJECTIONS - 1
        this.log.log('login-session-retire-deferred', {
          cause: 'pam-rejections',
          retryInMs
        })
        this.scheduleNextProbe(retryInMs)
        return
      }
      await this.retireIfResolverDegraded(() => {
        this.consecutiveRejections = REQUIRED_CONSECUTIVE_REJECTIONS - 1
      }, abortController.signal)
    } catch (error) {
      // A diagnostic probe rejection must not escape into the daemon’s fatal error handler.
      this.log.log('login-session-probe-error', { message: (error as Error)?.message })
      this.scheduleNextProbe(this.periodicProbeMs)
    } finally {
      this.probeInFlight = false
      if (this.probeAbortController === abortController) {
        this.probeAbortController = null
      }
      const pendingTrigger = this.pendingProbeTrigger
      this.pendingProbeTrigger = null
      if (!this.stopped && !this.retired && pendingTrigger !== null) {
        const elapsed = this.clock.now() - (this.lastProbeStartedAtMs ?? this.clock.now())
        this.scheduleProbeNoLaterThan(
          Math.max(0, this.probeGapMs(pendingTrigger) - elapsed),
          pendingTrigger
        )
      }
    }
  }

  private async retireIfResolverDegraded(
    holdAtThreshold: () => void,
    signal: AbortSignal
  ): Promise<void> {
    const resolverHealth = await this.readResolverHealth(signal)
    if (this.stopped || this.retired) {
      return
    }
    if (resolverHealth !== 'unhealthy') {
      // Require explicit resolver failure; unknown health preserves terminals at the periodic cadence.
      this.log.log('login-session-retire-suppressed', {
        cause: 'pam-rejections',
        resolverHealth
      })
      holdAtThreshold()
      this.scheduleNextProbe(this.periodicProbeMs)
      return
    }
    this.retired = true
    this.onRetire({
      cause: 'pam-rejections',
      rejections: this.consecutiveRejections,
      resolverHealth
    })
  }
}
