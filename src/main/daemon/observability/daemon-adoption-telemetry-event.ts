import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import {
  classifyDaemonAppVersionMatch,
  classifyDaemonPtyCwd,
  classifyDaemonSpawnerPath,
  isMacTccFolderClass,
  type DaemonSpawnerPathClass
} from '../../../shared/telemetry/daemon-adoption-telemetry'
import { bucketDaemonLiveSessionCount } from '../../../shared/telemetry/daemon-lifecycle-telemetry'
import type { EventProps } from '../../../shared/telemetry/telemetry-event-classification'
import { track } from '../../telemetry/client'
import { readDaemonPidRecordAsync } from '../endpoint/identity/daemon-endpoint-incarnation'
import { getDaemonMacCodeIdentity } from '../executable-host/macos/daemon-mac-code-identity'
import {
  getMacDaemonBundleRoot,
  MAC_DAEMON_COPY_PREFIX
} from '../executable-host/macos/macos-daemon-bundle'
import { enumerateDirectoryOnce } from '../permissions/directory-enumeration-probe'
import type { ParsedDaemonPid } from '../endpoint/identity/daemon-pid-file-parse'
import type { MacDaemonTccAttributionHealth } from '../permissions/daemon-tcc-attribution'
import type { DaemonEndpointIdentity } from '../protocol/daemon-hello-protocol'
import {
  clearDaemonFolderAccessMismatch,
  recordDaemonFolderAccessMismatch
} from '../permissions/daemon-folder-access-mismatch'
import {
  noteHelperFolderReadable,
  prepareTccDenialCapture,
  releaseTccDenialCapture,
  runTccDenialCapture
} from '../permissions/tcc-denial-capture'

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
  const spawnerExecPath = pidRecord?.spawnerExecPath ?? null
  const spawnerExists =
    spawnerExecPath !== null &&
    (await access(spawnerExecPath).then(
      () => true,
      () => false
    ))
  const spawnerPathClass: DaemonSpawnerPathClass = classifyDaemonSpawnerPath(
    spawnerExecPath,
    () => spawnerExists,
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
      ...(await classifyDaemonAdoptionOrigin(await readDaemonPidRecordAsync(pidPath)))
    })
  } catch {
    // Telemetry is best-effort; a dropped event must not reach the caller.
  }
}

type PendingDenial = { reallowed: boolean }

// A denial's app-side read can finish after the same helper read that folder class again; only
// denials still being read are kept, so this stays bounded.
const pendingDenials = new Map<string, Set<PendingDenial>>()

function trackPendingDenial(key: string): { denial: PendingDenial; settle: () => void } {
  const denial: PendingDenial = { reallowed: false }
  const pending = pendingDenials.get(key) ?? new Set<PendingDenial>()
  pendingDenials.set(key, pending.add(denial))
  return {
    denial,
    settle: () => {
      pending.delete(denial)
      if (pending.size === 0 && pendingDenials.get(key) === pending) {
        pendingDenials.delete(key)
      }
    }
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
    const deniedAtMs = Date.now()
    const cwdClass = classifyDaemonPtyCwd(cwd, homedir())
    const tccFolderClass =
      process.platform === 'darwin' && isMacTccFolderClass(cwdClass) ? cwdClass : null
    const helperClass = `${args.daemonIdentity?.pid}:${args.daemonIdentity?.launchNonce}:${cwdClass}`
    if (args.cwdReadableByDaemon === true) {
      for (const denial of pendingDenials.get(helperClass) ?? []) {
        denial.reallowed = true
      }
      clearDaemonFolderAccessMismatch(args.daemonIdentity, cwd)
      // TCC-gated folders only: elsewhere a readable cwd says nothing about the theory.
      if (tccFolderClass) {
        noteHelperFolderReadable(args.daemonIdentity, tccFolderClass)
        await trackDaemonPtyCwdVerdict('daemon_pty_cwd_readable', cwd, args.pidPath)
      }
      return
    }
    const { denial, settle } = trackPendingDenial(helperClass)
    let capture: Awaited<ReturnType<typeof prepareTccDenialCapture>> | null = null
    let diverged = false
    try {
      // The app-side opendir below can materialize a cloud folder, so read its state first.
      capture =
        tccFolderClass && args.cwdReadableByDaemon === false
          ? await prepareTccDenialCapture(args.daemonIdentity, tccFolderClass, deniedAtMs)
          : null
      diverged = await hasDaemonPtyCwdDenialDiverged(cwd, args.cwdReadableByDaemon)
    } finally {
      settle()
    }
    if (!diverged || denial.reallowed) {
      if (capture) {
        releaseTccDenialCapture(capture)
      }
      return
    }
    // Show the notice before waiting for the codesign probe.
    recordDaemonFolderAccessMismatch(args.daemonIdentity, cwd)
    if (capture) {
      void runTccDenialCapture(capture)
    }
    await trackDaemonPtyCwdVerdict('daemon_pty_cwd_denied', cwd, args.pidPath)
  } catch {
    // Best-effort evidence; a spawn must not fail because the notice could not be recorded.
  }
}
