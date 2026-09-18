import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'

/** Counterpart to `main_process_lifecycle_started`. Written once per launch on the
 *  committed quit path, so the next launch can tell an orderly exit from a whole-app
 *  death by whether this crumb closes the previous launch's durable trail. */
export const COMMITTED_QUIT_BREADCRUMB_NAME = 'main_process_quit_committed'

export type CommittedQuitReason =
  | 'update-install'
  | 'dev-parent-shutdown'
  | 'system-session-end'
  | 'app-quit'
  | 'relaunch-exit'

export type CommittedQuitSignals = {
  quittingForUpdate: boolean
  devParentShutdownRequested: boolean
  systemSessionEnding: boolean
}

// Why ordered, not combined: an update install that lands during a Windows session
// end is still an update install, and that is the reason a triager needs first.
export function resolveCommittedQuitReason(signals: CommittedQuitSignals): CommittedQuitReason {
  if (signals.quittingForUpdate) {
    return 'update-install'
  }
  if (signals.devParentShutdownRequested) {
    return 'dev-parent-shutdown'
  }
  if (signals.systemSessionEnding) {
    return 'system-session-end'
  }
  return 'app-quit'
}

function recordQuitCrumb(quitReason: CommittedQuitReason): void {
  recordDurableCrashBreadcrumb(COMMITTED_QUIT_BREADCRUMB_NAME, { quitReason })
}

export function recordCommittedQuitBreadcrumb(signals: CommittedQuitSignals): void {
  recordQuitCrumb(resolveCommittedQuitReason(signals))
}

/** For the relaunch paths that call `app.exit()`: it fires neither before-quit nor
 *  will-quit, so without a crumb here the next launch reads a deliberate restart —
 *  the GPU-fallback one lands right on the reports a GPU crash just created — as an
 *  abrupt whole-app death. */
export function recordRelaunchExitBreadcrumb(): void {
  recordQuitCrumb('relaunch-exit')
}
