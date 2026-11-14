import type { PRRefreshQueueEntry } from './pr-refresh-queue'
import { PRRefreshRequestRegistry } from './pr-refresh-request-registry'

export type PRRefreshRecoveryHooks = {
  run: (entry: PRRefreshQueueEntry) => Promise<void>
  tick: () => number | null
}

/** Recovery deadlines share the scheduler timer and expire even while a producer holds its slot. */
export class PRRefreshRecoveryLifecycle {
  protected recovery: PRRefreshRecoveryHooks | null = null
  private recoveryDeadline: number | null = null
  readonly requests = new PRRefreshRequestRegistry()

  setRecoveryHooks(hooks: PRRefreshRecoveryHooks | null): void {
    this.recovery = hooks
  }

  protected recoveryWait(delay: number): number {
    const remaining =
      this.recoveryDeadline === null ? Infinity : Math.max(0, this.recoveryDeadline - Date.now())
    return Math.min(delay, remaining)
  }

  protected tickRecovery(schedule: (delay: number) => void): void {
    if (this.recovery) {
      this.recoveryDeadline = this.recovery.tick()
      if (this.recoveryDeadline !== null) {
        schedule(Infinity)
      }
    }
  }
}
