import type { WorkerTerminalReleaseRuntime } from './worker-terminal-release-runtime'
import { reconcileRequestedWorkerTerminalReleases } from './worker-terminal-release-reconciliation'
import { releaseFederatedWorkerAtHomeDeadline } from '../rpc/methods/orchestration/federation/federated-worker-home-auto-release'

const MAX_TIMER_DELAY_MS = 2_147_483_647

const schedulerByRuntime = new WeakMap<
  WorkerTerminalReleaseRuntime,
  WorkerTerminalAutoReleaseScheduler
>()

// Keyed by runtime, not a field: the database can open while the runtime is still constructing.
export function getWorkerTerminalAutoReleaseScheduler(
  runtime: WorkerTerminalReleaseRuntime
): WorkerTerminalAutoReleaseScheduler {
  let scheduler = schedulerByRuntime.get(runtime)
  if (!scheduler) {
    scheduler = new WorkerTerminalAutoReleaseScheduler(runtime)
    schedulerByRuntime.set(runtime, scheduler)
  }
  return scheduler
}

/** One timer for the nearest settled-worker deadline, local or one the home keeps for an older host. */
export class WorkerTerminalAutoReleaseScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private timerDeadlineMs: number | undefined

  constructor(private readonly runtime: WorkerTerminalReleaseRuntime) {}

  rearm(): void {
    const next = this.runtime.getOrchestrationDb().nextWorkerTerminalAutoReleaseAtMs()
    if (this.timer && this.timerDeadlineMs === next) {
      return
    }
    this.clear()
    if (next === null) {
      return
    }
    const timer = setTimeout(
      () => {
        if (this.timer !== timer) {
          return
        }
        this.timer = undefined
        this.timerDeadlineMs = undefined
        void this.releaseDue()
      },
      Math.min(Math.max(0, next - Date.now()), MAX_TIMER_DELAY_MS)
    )
    timer.unref?.()
    this.timer = timer
    this.timerDeadlineMs = next
  }

  async releaseDue(): Promise<void> {
    try {
      const claimed = this.runtime
        .getOrchestrationDb()
        .claimDueWorkerTerminalAutoReleases(Date.now(), (resource) =>
          this.runtime.isWorkerAgentInTurn(resource)
        )
      if (claimed > 0) {
        await reconcileRequestedWorkerTerminalReleases(this.runtime)
      }
    } catch (error) {
      // Claimed rows stay requested, so release recovery retries them after the next inventory.
      warnAutoReleaseFailure(error)
    }
    try {
      const federated = this.runtime
        .getOrchestrationDb()
        .claimDueFederatedHomeAutoReleases(Date.now())
      await Promise.all(
        federated.map((dispatchId) =>
          releaseFederatedWorkerAtHomeDeadline(this.runtime, dispatchId).catch(
            warnAutoReleaseFailure
          )
        )
      )
    } catch (error) {
      warnAutoReleaseFailure(error)
    }
    try {
      this.rearm()
    } catch (error) {
      warnAutoReleaseFailure(error)
    }
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = undefined
    this.timerDeadlineMs = undefined
  }
}

function warnAutoReleaseFailure(error: unknown): void {
  console.warn('[orchestration] worker terminal auto-release failed', {
    error: error instanceof Error ? error.message : String(error)
  })
}
