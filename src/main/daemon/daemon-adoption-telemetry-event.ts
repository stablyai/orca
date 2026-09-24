// App-side emitters for `daemon_adopted`, `daemon_pty_cwd_denied`, and `daemon_pty_cwd_readable`
// (#17696). All sit on the daemon launch / PTY spawn path, so every failure dies here — telemetry
// can never cost a terminal.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  classifyDaemonPtyCwd,
  classifyDaemonSpawnerPath,
  isMacTccFolderClass,
  type DaemonAdoptedAppVersionMatch,
  type DaemonSpawnerPathClass
} from '../../shared/daemon-adoption-telemetry'
import { bucketDaemonLiveSessionCount } from '../../shared/daemon-lifecycle-telemetry'
import type { EventProps } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { getDaemonMacCodeIdentity } from './daemon-mac-code-identity'
import { enumerateDirectoryOnce } from './directory-enumeration-probe'
import type { ParsedDaemonPid } from './daemon-pid-file-parse'
import type { MacDaemonTccAttributionHealth } from './daemon-tcc-attribution'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import {
  clearDaemonFolderAccessMismatch,
  recordDaemonFolderAccessMismatch
} from './daemon-folder-access-mismatch'

export type DaemonAdoptionOrigin = Pick<
  EventProps<'daemon_pty_cwd_denied'>,
  'app_version_match' | 'code_identity' | 'spawner_path_class'
>

/** Classifies the adopted daemon's pid record against the running app; enum-only by construction. */
export async function classifyDaemonAdoptionOrigin(
  pidRecord: ParsedDaemonPid | null
): Promise<DaemonAdoptionOrigin> {
  const appVersionMatch: DaemonAdoptedAppVersionMatch = !pidRecord?.appVersion
    ? 'unknown'
    : pidRecord.appVersion === getAppEnvironment().getVersion()
      ? 'same'
      : 'different'
  const spawnerPathClass: DaemonSpawnerPathClass = classifyDaemonSpawnerPath(
    pidRecord?.spawnerExecPath ?? null,
    existsSync
  )
  return {
    app_version_match: appVersionMatch,
    code_identity: await getDaemonMacCodeIdentity(pidRecord?.pid),
    spawner_path_class: spawnerPathClass
  }
}

// Adopted a daemon that a previous app launch forked (macOS only; that is where attribution matters).
export async function trackDaemonAdopted(
  pidRecord: ParsedDaemonPid | null,
  tccAttribution: MacDaemonTccAttributionHealth,
  liveSessionCount: number | null
): Promise<void> {
  try {
    track('daemon_adopted', {
      ...(await classifyDaemonAdoptionOrigin(pidRecord)),
      tcc_attribution: tccAttribution,
      live_session_count_bucket: bucketDaemonLiveSessionCount(liveSessionCount)
    })
  } catch {
    // Telemetry is best-effort; a dropped event must not fail daemon adoption.
  }
}

/**
 * Proven divergence: the daemon reported the cwd unreadable AND this process can enumerate it.
 * A cwd neither can read (chmod, ENOENT, unmounted volume) is not the #17696 shape. Single oracle
 * for both the event below and the user-facing notice, so the app-side read happens once.
 */
export async function hasDaemonPtyCwdDenialDiverged(
  cwd: string | undefined,
  cwdReadableByDaemon: boolean | undefined
): Promise<boolean> {
  try {
    if (process.platform !== 'darwin' || !cwd || cwdReadableByDaemon !== false) {
      return false
    }
    return (await enumerateDirectoryOnce(cwd)) === 'ok'
  } catch {
    return false
  }
}

/** Emits a spawn's cwd verdict; `readable` is the control that gives `code_identity` a false-positive rate. */
export async function trackDaemonPtyCwdVerdict(
  event: 'daemon_pty_cwd_denied' | 'daemon_pty_cwd_readable',
  cwd: string,
  pidPath: string | null
): Promise<void> {
  try {
    // Why read now, not the adapter's startup snapshot: a respawn swaps the daemon under a
    // long-lived adapter, and the verdict must be attributed to the daemon that just spawned.
    track(event, {
      cwd_class: classifyDaemonPtyCwd(cwd, homedir()),
      ...(await classifyDaemonAdoptionOrigin(readDaemonPidRecord(pidPath)))
    })
  } catch {
    // Telemetry is best-effort; a dropped event must not reach the caller.
  }
}

/**
 * The spawn path's single reader of the daemon's cwd verdict: one directory read feeds both the
 * event and the user-facing notice. Local current-protocol daemons only — one that omits the
 * verdict reports nothing. Every failure dies here; neither may ever cost a terminal.
 *
 * Never rejects, and the caller must not wait for it: the app-side read is what raises the macOS
 * folder prompt, which holds the syscall for as long as the user leaves the sheet up.
 */
export async function reportDaemonPtyCwdVerdict(args: {
  cwd: string | undefined
  cwdReadableByDaemon: boolean | undefined
  pidPath: string | null
  daemonIdentity: DaemonEndpointIdentity | null
}): Promise<void> {
  try {
    const { cwd } = args
    if (!cwd) {
      return
    }
    if (args.cwdReadableByDaemon === true) {
      clearDaemonFolderAccessMismatch(args.daemonIdentity, cwd)
      // TCC-gated folders only: elsewhere a readable cwd says nothing about the theory.
      if (
        process.platform === 'darwin' &&
        isMacTccFolderClass(classifyDaemonPtyCwd(cwd, homedir()))
      ) {
        await trackDaemonPtyCwdVerdict('daemon_pty_cwd_readable', cwd, args.pidPath)
      }
      return
    }
    if (!(await hasDaemonPtyCwdDenialDiverged(cwd, args.cwdReadableByDaemon))) {
      return
    }
    // Notice first: the event now waits on a codesign probe, and the user-facing notice must not.
    recordDaemonFolderAccessMismatch(args.daemonIdentity, cwd)
    await trackDaemonPtyCwdVerdict('daemon_pty_cwd_denied', cwd, args.pidPath)
  } catch {
    // Best-effort evidence; a spawn must not fail because the notice could not be recorded.
  }
}
