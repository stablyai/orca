// Capture macOS's verdict once per helper incarnation and folder class when a denial is confirmed.

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MacTccFolderClass } from '../../../shared/daemon-adoption-telemetry'
import {
  bucketElapsed,
  bucketGoodReadCount,
  bucketHelperAge,
  type FullDiskAccessValue,
  type HelperOrigin
} from '../../../shared/daemon-tcc-denial-capture'
import { LOCAL_BUILD_COMPATIBILITY_CONTRACT } from '../../../shared/local-build-compatibility-contract'
import type { EventProps } from '../../../shared/telemetry-events'
import { msSinceWakeSignal } from '../../power/wake-signal-clock'
import { track } from '../../telemetry/client'
import { inspectMacProcessCodeIdentity } from '../executable-host/macos/daemon-mac-code-identity'
import { getLastMacDaemonForkReason } from '../executable-host/macos/macos-daemon-fork-reason'
import type { DaemonEndpointIdentity } from '../protocol/daemon-hello-protocol'
import { readTccFolderState, type TccFolderState } from './tcc-denial-folder-state'
import { readTccLogVerdict } from './tcc-denial-log-verdict'
import { checkHelperSignatures } from './tcc-denial-signature-checks'

const MAX_TRACKED_KEYS = 256
const CLASS_ROOT_NAME: Record<MacTccFolderClass, string> = {
  documents: 'Documents',
  desktop: 'Desktop',
  downloads: 'Downloads'
}
const UNKNOWN_FOLDER_STATE: TccFolderState = {
  dataless: 'unknown',
  icloud: 'unknown',
  volumeType: 'unknown'
}
const APP_STARTED_AT_MS = Date.now() - process.uptime() * 1_000

export type TccDenialCaptureStart = {
  key: string
  identity: DaemonEndpointIdentity
  cwdClass: MacTccFolderClass
  denialAtMs: number
  folderState: TccFolderState
  /** Taken at the denial, before any await, so later reads and wakes cannot leak in. */
  context: Pick<
    EventProps<'daemon_pty_cwd_denial_capture'>,
    | 'good_reads_bucket'
    | 'since_good_read_bucket'
    | 'since_resume_bucket'
    | 'since_unlock_bucket'
    | 'since_user_active_bucket'
  >
}

type GoodReads = { count: number; lastAtMs: number }

const goodReads = new Map<string, GoodReads>()
const claimedKeys = new Map<string, 'preparing' | 'captured'>()

function captureKey(identity: DaemonEndpointIdentity, cwdClass: MacTccFolderClass): string {
  return `${identity.pid}:${identity.startedAtMs}:${identity.launchNonce}:${cwdClass}`
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key)
  map.set(key, value)
  // Bounded memory: past 256 helper-class keys the oldest may be captured once more.
  for (const oldest of map.keys()) {
    if (map.size <= MAX_TRACKED_KEYS) {
      break
    }
    map.delete(oldest)
  }
}

/** Earlier good reads are the "was readable, then flipped" evidence for this helper. */
export function noteHelperFolderReadable(
  identity: DaemonEndpointIdentity | null,
  cwdClass: MacTccFolderClass,
  nowMs: number = Date.now()
): void {
  if (!identity) {
    return
  }
  const key = captureKey(identity, cwdClass)
  remember(goodReads, key, { count: (goodReads.get(key)?.count ?? 0) + 1, lastAtMs: nowMs })
}

/** Read the folder state before the app-side opendir; null once this helper and class were captured. */
export async function prepareTccDenialCapture(
  identity: DaemonEndpointIdentity | null,
  cwdClass: MacTccFolderClass,
  denialAtMs: number,
  readFolderState: typeof readTccFolderState = readTccFolderState
): Promise<TccDenialCaptureStart | null> {
  if (!identity) {
    return null
  }
  const key = captureKey(identity, cwdClass)
  if (claimedKeys.has(key)) {
    return null
  }
  // Claim before the first await: a burst of restored terminals in one folder probes once.
  remember(claimedKeys, key, 'preparing')
  const reads = goodReads.get(key)
  const context: TccDenialCaptureStart['context'] = {
    good_reads_bucket: bucketGoodReadCount(reads?.count ?? 0),
    since_good_read_bucket: bucketElapsed(reads ? denialAtMs - reads.lastAtMs : null),
    since_resume_bucket: bucketElapsed(msSinceWakeSignal('resume', denialAtMs)),
    since_unlock_bucket: bucketElapsed(msSinceWakeSignal('unlock-screen', denialAtMs)),
    since_user_active_bucket: bucketElapsed(msSinceWakeSignal('user-did-become-active', denialAtMs))
  }
  const folderState = await readFolderState(
    join(homedir(), CLASS_ROOT_NAME[cwdClass]),
    cwdClass
  ).catch(() => UNKNOWN_FOLDER_STATE)
  return { key, identity, cwdClass, denialAtMs, folderState, context }
}

/** The app was refused too, so nothing diverged: let a later denial on this helper capture. */
export function releaseTccDenialCapture(start: TccDenialCaptureStart): void {
  if (claimedKeys.get(start.key) === 'preparing') {
    claimedKeys.delete(start.key)
  }
}

async function readFullDiskAccess(): Promise<FullDiskAccessValue> {
  try {
    // Lazy: the status reader reaches the provider modules that import this capture.
    const { getTerminalHostsFullDiskAccessStatus } =
      await import('./daemon-full-disk-access-status')
    const status = await getTerminalHostsFullDiskAccessStatus()
    return status === 'granted' || status === 'denied' || status === 'unsupported'
      ? status
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

function helperOriginOf(identity: DaemonEndpointIdentity): HelperOrigin {
  if (!Number.isFinite(identity.startedAtMs) || identity.startedAtMs <= 0) {
    return 'unknown'
  }
  return identity.startedAtMs < APP_STARTED_AT_MS ? 'adopted' : 'spawned'
}

/** Never throws, never blocks a spawn; at most one capture per helper incarnation and folder class. */
export async function runTccDenialCapture(start: TccDenialCaptureStart): Promise<void> {
  if (claimedKeys.get(start.key) === 'captured') {
    return
  }
  remember(claimedKeys, start.key, 'captured')
  try {
    const { identity, cwdClass, denialAtMs, folderState } = start
    const helperPath =
      (await inspectMacProcessCodeIdentity(identity.pid)).executablePath ??
      identity.spawnerExecPath ??
      null
    const [log, signatures, fullDiskAccess] = await Promise.all([
      readTccLogVerdict(denialAtMs, {
        helperPid: identity.pid,
        helperPath,
        appId: LOCAL_BUILD_COMPATIBILITY_CONTRACT.appId,
        cwdClass
      }),
      checkHelperSignatures(identity.pid, helperPath),
      readFullDiskAccess()
    ])
    const origin = helperOriginOf(identity)
    const props: EventProps<'daemon_pty_cwd_denial_capture'> = {
      cwd_class: cwdClass,
      log_access: log.logAccess,
      tccd_asked: log.tccdAsked,
      auth_value: log.authValue,
      auth_reason: log.authReason,
      service: log.service,
      requirement_failure: log.requirementFailure,
      kernel_deny: log.kernelDeny,
      live_signature: signatures.live,
      disk_copy_signature: signatures.diskCopy,
      helper_age_bucket: bucketHelperAge(
        identity.startedAtMs > 0 ? denialAtMs - identity.startedAtMs : null
      ),
      helper_origin: origin,
      ...start.context,
      full_disk_access: fullDiskAccess,
      // An adopted helper was launched by an earlier app process whose reason is gone.
      fork_fallback: origin === 'spawned' ? (getLastMacDaemonForkReason() ?? 'none') : 'unknown',
      folder_dataless: folderState.dataless,
      folder_icloud: folderState.icloud,
      volume_type: folderState.volumeType
    }
    track('daemon_pty_cwd_denial_capture', props)
  } catch {
    // Diagnostics are best-effort; a failed capture must not reach terminal creation.
  }
}

export function resetTccDenialCaptureForTests(): void {
  goodReads.clear()
  claimedKeys.clear()
}
