import { orchestrationDbFile } from '../../orchestration/db/orchestration-db-file'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { OrcaRuntimeWithPtyForegroundProcessReads } from '../../client/runtime-client-state'
import { getWorkerTerminalAutoReleaseScheduler } from '../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { resolveOrchestrationRunRetentionHours } from '../../orchestration/retention/orchestration-retention-scheduler'
import { structuredMailboxCustody } from '../../orchestration/mailbox/routing/structured-session-mail-target'

// Keyed by runtime, not a field: the database can open while the runtime is still constructing.
const runtimesWatchingAutoReleaseSetting = new WeakSet<object>()

export abstract class OrcaRuntimeWithOrchestrationDatabaseBinding extends OrcaRuntimeWithPtyForegroundProcessReads {
  protected orchestrationDbPath(): string {
    return orchestrationDbFile(getAppEnvironment().getPath('userData'))
  }

  getOrchestrationRunRetentionHours(): number {
    return resolveOrchestrationRunRetentionHours(
      this.store?.getSettings?.()?.orchestrationRunRetentionHours
    )
  }

  abstract hasLiveTerminalForPaneKey(paneKey: string): boolean

  isLiveOrchestrationHandle(handle: string): boolean {
    return (
      (this.messageWaiters.get(handle)?.size ?? 0) > 0 ||
      this.orchestrationMailboxDeliveryTarget.reachesOpenTerminal(handle) ||
      structuredMailboxCustody(handle, this._orchestrationDb) !== 'elsewhere'
    )
  }

  protected bindWorkerTerminalAutoRelease(db: OrchestrationDb): void {
    db.workerTerminalAutoReleaseListener = () => {
      if (this._orchestrationDb === db) {
        getWorkerTerminalAutoReleaseScheduler(this).rearm()
      }
    }
    db.workerAutoReleaseEnabled = () =>
      this.store?.getSettings?.()?.orchestrationWorkerAutoReleaseEnabled !== false
    if (this.store?.onSettingsChanged && !runtimesWatchingAutoReleaseSetting.has(this)) {
      runtimesWatchingAutoReleaseSetting.add(this)
      // Turning the setting off drops the timer; turning it on finds the deadlines still due.
      this.store.onSettingsChanged((updates) => {
        if ('orchestrationWorkerAutoReleaseEnabled' in updates && this._orchestrationDb) {
          getWorkerTerminalAutoReleaseScheduler(this).rearm()
        }
      })
    }
  }
}
