import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { setCrashBreadcrumbRecordedListener } from './crash-breadcrumb-store'
import { getPreviousSessionCrashpadDump } from './crashpad-capture'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'
import { getMainProcessLifecycleIdentity } from './main-process-lifecycle-identity'
import {
  beginMainSessionTracking,
  noteMainSessionActivity,
  recordProvisionalMainSessionExitSync,
  type PreviousSessionCrashpadDump,
  type PreviousUncleanMainSession
} from './main-session-exit-marker'

let pendingReport: PreviousUncleanMainSession | null = null

/** Call after the single-instance lock and before startCrashpadCapture. */
export function startMainSessionExitTracking(
  userDataPath: string,
  appVersion: string
): PreviousUncleanMainSession | null {
  pendingReport = beginMainSessionTracking({
    userDataPath,
    identity: getMainProcessLifecycleIdentity(),
    appVersion
  })
  setCrashBreadcrumbRecordedListener(noteMainSessionActivity)
  return pendingReport
}

export function buildUncleanMainExitBreadcrumbData(
  previous: PreviousUncleanMainSession,
  dump: PreviousSessionCrashpadDump | null
): CrashReportBreadcrumbData {
  return {
    previousLaunchId: previous.launchId,
    previousPid: previous.pid,
    previousStartedAt: previous.startedAt,
    previousAppVersion: previous.appVersion,
    previousLastBreadcrumbAt: previous.lastBreadcrumbAt,
    crashpadDumpAfterStart: dump !== null,
    ...(dump
      ? {
          dumpWrittenAt: dump.writtenAt,
          dumpSizeBytes: dump.sizeBytes,
          dumpProcessType: dump.processType,
          dumpCount: dump.dumpCount
        }
      : {})
  }
}

/** Call once observability is up so the breadcrumb reaches the diagnostic log. */
export async function reportPreviousUncleanMainExit(): Promise<void> {
  const previous = pendingReport
  pendingReport = null
  if (!previous) {
    return
  }
  const dump = await getPreviousSessionCrashpadDump()
  recordDurableCrashBreadcrumb(
    'main_previous_session_unclean_exit',
    buildUncleanMainExitBreadcrumbData(previous, dump)
  )
}

type ShutdownNotifier = { on(event: 'shutdown', listener: () => void): unknown }

/** Labels an OS shutdown that may end the process before will-quit. */
export function installOsShutdownExitRecord(
  monitor: ShutdownNotifier,
  platform: NodeJS.Platform
): void {
  // Why not Windows: session-end labels OS teardown there and is already committed.
  if (platform === 'win32') {
    return
  }
  // Why provisional: macOS/logind announce shutdown while another app can still cancel it.
  monitor.on('shutdown', () => recordProvisionalMainSessionExitSync('os-shutdown'))
}
