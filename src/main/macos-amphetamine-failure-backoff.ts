type Logger = Pick<Console, 'debug' | 'warn'>

export type AmphetamineFailureBackoffOptions = {
  logger: Logger
  now: () => number
  retryMs: number
  onRetryDue: () => void
}

/** Rate-limits observation retries and collapses a repeating failure into one warning. */
export class AmphetamineFailureBackoff {
  private readonly logger: Logger
  private readonly now: () => number
  private readonly retryMs: number
  private readonly onRetryDue: () => void
  private retryNotBefore: number | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private lastFailureKey: string | null = null
  private warnedForLastFailure = false

  constructor(options: AmphetamineFailureBackoffOptions) {
    this.logger = options.logger
    this.now = options.now
    this.retryMs = options.retryMs
    this.onRetryDue = options.onRetryDue
  }

  /** True while a recent failure means the next attempt should be skipped. */
  isSuppressed(): boolean {
    if (this.retryNotBefore === null || this.now() >= this.retryNotBefore) {
      return false
    }
    this.scheduleRetry()
    return true
  }

  record(failureKey: string, reason: string, details: unknown): void {
    const payload = { reason, details }
    if (this.lastFailureKey === failureKey && this.warnedForLastFailure) {
      this.logger.debug('[agent-awake] Amphetamine session observation failed repeatedly', payload)
    } else {
      this.lastFailureKey = failureKey
      this.warnedForLastFailure = true
      this.logger.warn('[agent-awake] Amphetamine session observation failed', payload)
    }
    this.retryNotBefore = this.now() + this.retryMs
    this.scheduleRetry()
  }

  reset(): void {
    this.retryNotBefore = null
    this.lastFailureKey = null
    this.warnedForLastFailure = false
    if (!this.retryTimer) {
      return
    }
    clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private scheduleRetry(): void {
    if (this.retryNotBefore === null || this.retryTimer) {
      return
    }
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null
        this.onRetryDue()
      },
      Math.max(0, this.retryNotBefore - this.now())
    )
    if (typeof this.retryTimer.unref === 'function') {
      this.retryTimer.unref()
    }
  }
}
