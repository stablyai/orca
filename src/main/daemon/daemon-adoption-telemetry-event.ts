import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  classifyDaemonAppVersionMatch,
  classifyDaemonPtyCwd,
  classifyDaemonSpawnerPath,
  isMacTccFolderClass,
  type DaemonSpawnerPathClass
} from '../../shared/daemon-adoption-telemetry'
import { bucketDaemonLiveSessionCount } from '../../shared/daemon-lifecycle-telemetry'
import type { EventProps } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { getDaemonMacCodeIdentity } from './daemon-mac-code-identity'
import { getMacDaemonBundleRoot, MAC_DAEMON_COPY_PREFIX } from './macos-daemon-bundle'
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

function stableCopyPrefix(): string | null {
  try {
    return join(
      getMacDaemonBundleRoot(getAppEnvironment().getPath('userData')),
      MAC_DAEMON_COPY_PREFIX
    )
  } catch {
    return null
  }
}

export async function classifyDaemonAdoptionOrigin(
  pidRecord: ParsedDaemonPid | null
): Promise<DaemonAdoptionOrigin> {
  const appVersionMatch = classifyDaemonAppVersionMatch(
    pidRecord?.appVersion,
    getAppEnvironment().getVersion()
  )
  const spawnerPathClass: DaemonSpawnerPathClass = classifyDaemonSpawnerPath(
    pidRecord?.spawnerExecPath ?? null,
    existsSync,
    stableCopyPrefix()
  )
  return {
    app_version_match: appVersionMatch,
    code_identity: await getDaemonMacCodeIdentity(pidRecord?.pid),
    spawner_path_class: spawnerPathClass
  }
}

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

/** Confirm daemon denial with one app-side directory read shared by telemetry and the notice. */
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

/** Readable spawns provide the control group for cwd-denial telemetry. */
export async function trackDaemonPtyCwdVerdict(
  event: 'daemon_pty_cwd_denied' | 'daemon_pty_cwd_readable',
  cwd: string,
  pidPath: string | null
): Promise<void> {
  try {
    // Re-read identity because a long-lived adapter may now use a respawned daemon.
    track(event, {
      cwd_class: classifyDaemonPtyCwd(cwd, homedir()),
      ...(await classifyDaemonAdoptionOrigin(readDaemonPidRecord(pidPath)))
    })
  } catch {
    // Telemetry is best-effort; a dropped event must not reach the caller.
  }
}

/** Do not await: the app-side directory read can wait indefinitely on a macOS permission prompt. */
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
    // Show the notice before waiting for the codesign probe.
    recordDaemonFolderAccessMismatch(args.daemonIdentity, cwd)
    await trackDaemonPtyCwdVerdict('daemon_pty_cwd_denied', cwd, args.pidPath)
  } catch {
    // Best-effort evidence; a spawn must not fail because the notice could not be recorded.
  }
}
