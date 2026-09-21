// App-side emitters for `daemon_adopted` and `daemon_pty_cwd_denied` (#17696). Both sit on the
// daemon launch / PTY spawn path, so every failure dies here — telemetry can never cost a terminal.

import { accessSync, constants as fsConstants, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  classifyDaemonPtyCwd,
  classifyDaemonSpawnerPath,
  type DaemonAdoptedAppVersionMatch,
  type DaemonSpawnerPathClass
} from '../../shared/daemon-adoption-telemetry'
import { bucketDaemonLiveSessionCount } from '../../shared/daemon-lifecycle-telemetry'
import type { EventProps } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'
import type { MacDaemonTccAttributionHealth } from './daemon-tcc-attribution'

export type DaemonAdoptionOrigin = Pick<
  EventProps<'daemon_pty_cwd_denied'>,
  'app_version_match' | 'spawner_path_class'
>

/** Classifies the adopted daemon's pid record against the running app; enum-only by construction. */
export function classifyDaemonAdoptionOrigin(
  pidRecord: ParsedDaemonPid | null
): DaemonAdoptionOrigin {
  const appVersionMatch: DaemonAdoptedAppVersionMatch = !pidRecord?.appVersion
    ? 'unknown'
    : pidRecord.appVersion === getAppEnvironment().getVersion()
      ? 'same'
      : 'different'
  const spawnerPathClass: DaemonSpawnerPathClass = classifyDaemonSpawnerPath(
    pidRecord?.spawnerExecPath ?? null,
    existsSync
  )
  return { app_version_match: appVersionMatch, spawner_path_class: spawnerPathClass }
}

// Adopted a daemon that a previous app launch forked (macOS only; that is where attribution matters).
export function trackDaemonAdopted(
  pidRecord: ParsedDaemonPid | null,
  tccAttribution: MacDaemonTccAttributionHealth,
  liveSessionCount: number | null
): void {
  try {
    track('daemon_adopted', {
      ...classifyDaemonAdoptionOrigin(pidRecord),
      tcc_attribution: tccAttribution,
      live_session_count_bucket: bucketDaemonLiveSessionCount(liveSessionCount)
    })
  } catch {
    // Telemetry is best-effort; a dropped event must not fail daemon adoption.
  }
}

/**
 * Emits only on proven divergence: the daemon reported the cwd unreadable AND this process can
 * read it. A cwd neither can read (chmod, ENOENT, unmounted volume) is not the #17696 shape.
 */
export function trackDaemonPtyCwdDeniedIfDiverged(
  cwd: string | undefined,
  cwdReadableByDaemon: boolean | undefined,
  pidPath: string | null
): void {
  try {
    if (process.platform !== 'darwin' || !cwd || cwdReadableByDaemon !== false) {
      return
    }
    accessSync(cwd, fsConstants.R_OK | fsConstants.X_OK)
    // Why read now, not the adapter's startup snapshot: a respawn swaps the daemon under a
    // long-lived adapter, and the denial must be attributed to the daemon that just spawned.
    track('daemon_pty_cwd_denied', {
      cwd_class: classifyDaemonPtyCwd(cwd, homedir()),
      ...classifyDaemonAdoptionOrigin(readDaemonPidRecord(pidPath))
    })
  } catch {
    // Either the app cannot read it (no divergence) or telemetry failed; neither may reach the caller.
  }
}
