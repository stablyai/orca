import { orchestrationDbFile } from '../../orchestration/db/orchestration-db-file'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { OrcaRuntimeWithPtyForegroundProcessReads } from '../../client/runtime-client-state'
import { getWorkerTerminalAutoReleaseScheduler } from '../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import { readWorkerAutoReleaseEnvironment } from '../../orchestration/db/worker-terminal/worker-auto-release-environment'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'

// Keyed by runtime, not a field: the database can open while the runtime is still constructing.
const runtimesWatchingAutoReleaseSetting = new WeakSet<object>()

export abstract class OrcaRuntimeWithOrchestrationDatabaseBinding extends OrcaRuntimeWithPtyForegroundProcessReads {
  protected orchestrationDbPath(): string {
    return orchestrationDbFile(getAppEnvironment().getPath('userData'))
  }

  protected bindWorkerTerminalAutoRelease(db: OrchestrationDb): void {
    db.workerTerminalAutoReleaseListener = () => {
      if (this._orchestrationDb === db) {
        getWorkerTerminalAutoReleaseScheduler(this).rearm()
      }
    }
    // Why: a headless `orca serve` has no local Settings window, so its environment decides when set.
    const environment = readWorkerAutoReleaseEnvironment(process.env)
    if (environment.invalid.length > 0) {
      console.warn(
        '[orchestration] ignoring invalid worker auto-release settings:',
        environment.invalid
      )
    }
    db.workerAutoReleaseEnabled = () =>
      environment.enabled ??
      this.store?.getSettings?.()?.orchestrationWorkerAutoReleaseEnabled !== false
    const { graceMs } = environment
    db.workerAutoReleaseGraceMs = graceMs === undefined ? undefined : () => graceMs
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
