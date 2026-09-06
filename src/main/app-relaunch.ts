import { app } from 'electron'
import type { CrashReportBreadcrumbData } from '../shared/crash-reporting'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import { isMacUpdateInstallInFlight } from './mac-update-install-marker'
import { runWithLaunchPath } from './startup/hydrate-shell-path'

export type AppRelaunchReason =
  | 'admin-restart'
  | 'gpu-fallback'
  | 'profile-switch'
  | 'profile-transfer'
  | 'renderer-request'

// Why: Electron queues one replacement process per app.relaunch() call and offers no way to
// withdraw one ("multiple instances will be started after current instance exited"). Callers
// that pair it with a vetoable app.quit() would otherwise leave a queued instance behind on
// every restart that does not take, and the whole backlog launches at the next real exit.
let relaunchQueued = false
let quitRelaunchListener: (() => void) | null = null
let relaunchScheduledAtMs = 0

/**
 * How long a scheduled relaunch stays valid.
 *
 * Not every abandoned quit is observable: main `preventDefault()`s the window close and asks the
 * renderer, and if the user then cancels, nothing tells main
 * (`window/main-window-close-lifecycle.ts:115`) — only a prevented beforeunload reports back.
 * So the deferred relaunch cannot rely on an explicit cancel alone, or an abandoned restart would
 * be resurrected by an unrelated quit hours later. Generous enough to cover a slow teardown (the
 * quit deadline is 20s, plus renderer scrollback capture), short enough that it cannot surprise
 * someone much later.
 */
const RELAUNCH_SCHEDULE_VALIDITY_MS = 5 * 60_000

function queueRelaunchOnce(): void {
  if (relaunchQueued) {
    return
  }
  // Why here rather than only in the deferred path: the immediate callers (GPU fallback, renderer
  // restart) relaunch too, and relaunching the OLD bundle mid-install cancels the update just as
  // effectively. One check covers every caller.
  //
  // Yielding is safe even for those callers, because they follow with app.exit(0) regardless: the
  // process still exits, which is exactly what the installer is waiting for, and the installer
  // then relaunches the NEW version. Skipping our relaunch trades a restart of the old build for
  // a restart of the updated one — never for no restart at all.
  if (isMacUpdateInstallInFlight()) {
    recordDurableCrashBreadcrumb('app_relaunch_yielded_to_installer', {})
    return
  }
  relaunchQueued = true
  runWithLaunchPath(() => app.relaunch())
}

/** Queue the replacement process now. Only for callers that follow with `app.exit()`, which
 *  cannot be vetoed; a vetoable quit must use {@link scheduleRelaunchOnQuit} instead. */
export function relaunchApp(reason: AppRelaunchReason, data?: CrashReportBreadcrumbData): void {
  // Why: the current process can exit immediately after app.relaunch(), so
  // persist the cause before Electron schedules the replacement process.
  recordDurableCrashBreadcrumb('app_relaunch_requested', { ...data, reason })
  queueRelaunchOnce()
}

/**
 * Queue the replacement process only if the app actually exits.
 *
 * `app.quit()` is vetoable — a renderer beforeunload guard, or teardown that never settles,
 * can abandon it and leave the app running. Deferring to `quit` means an abandoned restart
 * queues nothing, and the one-shot listener means repeated attempts queue one instance, not one
 * per attempt.
 *
 * The listener must be withdrawn when the quit is abandoned (see {@link cancelScheduledRelaunch});
 * otherwise an abandoned restart is resurrected by the next unrelated quit, hours later.
 */
export function scheduleRelaunchOnQuit(
  reason: AppRelaunchReason,
  data?: CrashReportBreadcrumbData
): void {
  // Why record here rather than at quit: the request is the diagnostic event, and it is the
  // last thing written if the quit is then abandoned.
  recordDurableCrashBreadcrumb('app_relaunch_requested', { ...data, reason })
  if (quitRelaunchListener) {
    return
  }
  relaunchScheduledAtMs = Date.now()
  quitRelaunchListener = () => {
    // Why skip when an update is installing: the installer owns the relaunch and refuses to swap
    // the bundle while an instance runs, so relaunching here would restart the OLD version and
    // cancel the very update this quit was going to apply.
    // Why the staleness check: this quit may be an unrelated one, long after a restart the user
    // abandoned. Restarting then would look like the app reopening by itself.
    if (Date.now() - relaunchScheduledAtMs > RELAUNCH_SCHEDULE_VALIDITY_MS) {
      recordDurableCrashBreadcrumb('app_relaunch_expired', {})
      return
    }
    queueRelaunchOnce()
  }
  app.once('quit', quitRelaunchListener)
}

/** Withdraw a relaunch scheduled for a quit that did not happen. */
export function cancelScheduledRelaunch(): void {
  if (!quitRelaunchListener) {
    return
  }
  app.removeListener('quit', quitRelaunchListener)
  quitRelaunchListener = null
  relaunchScheduledAtMs = 0
}

export function _resetAppRelaunchStateForTests(): void {
  if (quitRelaunchListener) {
    app.removeListener?.('quit', quitRelaunchListener)
  }
  relaunchQueued = false
  quitRelaunchListener = null
  relaunchScheduledAtMs = 0
}
