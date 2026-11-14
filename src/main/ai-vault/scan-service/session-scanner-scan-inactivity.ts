import { scanRecoveryInterest } from '../scan-lifecycle/ai-vault-scan-recovery'

const SCAN_INACTIVITY_MS = 60_000

/** Only started calls with a live explicit-refresh owner can recover from missing I/O progress. */
export class SessionScanInactivity {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastActivity: number | null = null
  private allowance = 0
  private readonly interest
  private disposed = false

  constructor(
    signal: AbortSignal | undefined,
    private readonly stalled: () => void
  ) {
    this.interest = scanRecoveryInterest(signal)
    this.interest?.listeners.add(this.schedule)
  }

  activity(allowanceMs: number): void {
    this.lastActivity = Date.now()
    this.allowance = allowanceMs
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.interest?.listeners.delete(this.schedule)
  }

  private readonly schedule = (): void => {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    if (
      this.disposed ||
      !this.interest ||
      this.interest.forced + this.interest.inherited === 0 ||
      this.lastActivity === null
    ) {
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.stalled()
      },
      Math.max(0, this.lastActivity + SCAN_INACTIVITY_MS + this.allowance - Date.now())
    )
    this.timer.unref?.()
  }
}

export class AiVaultScanStalledError extends Error {
  constructor() {
    super('AI Vault service stopped making progress.')
  }
}
