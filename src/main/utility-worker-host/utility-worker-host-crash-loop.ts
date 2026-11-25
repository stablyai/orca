import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { ManagedOrcadEventWindow } from '../managed-server/lifecycle/orcad-managed-event-window'
import { UtilityWorkerHostPausedError } from './utility-worker-host-protocol'

/** After repeated crashes a capped host refuses work until a user retries; never moves it in-process. */
export type UtilityWorkerHostCrashCap = {
  crashes: number
  windowMs: number
  message: string
  onPause: () => void
  onResume: () => void
}

/** Crashes in a sliding window; at the cap it latches paused until a retry, not until time passes. */
export class UtilityWorkerHostCrashLoop {
  private readonly crashes: ManagedOrcadEventWindow
  private paused = false

  constructor(
    private readonly serviceName: string,
    private readonly cap: UtilityWorkerHostCrashCap
  ) {
    this.crashes = new ManagedOrcadEventWindow(cap.windowMs, Date.now)
  }

  get pauseMessage(): string | null {
    return this.paused ? this.cap.message : null
  }

  throwIfPaused(): void {
    if (this.paused) {
      throw new UtilityWorkerHostPausedError(this.cap.message)
    }
  }

  record(): void {
    if (this.paused) {
      return
    }
    this.crashes.record(this.serviceName)
    const recent = this.crashes.recent(this.serviceName).length
    if (recent >= this.cap.crashes) {
      this.paused = true
      recordDurableCrashBreadcrumb('utility_worker_host_paused', {
        serviceName: this.serviceName,
        crashes: recent
      })
      this.cap.onPause()
    }
  }

  retry(): void {
    if (!this.paused) {
      return
    }
    recordDurableCrashBreadcrumb('utility_worker_host_retried', { serviceName: this.serviceName })
    this.paused = false
    this.crashes.forget(this.serviceName)
    this.cap.onResume()
  }
}
