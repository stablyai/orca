import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess, spawnProcess } from '../shared/child-process/run-process'
import {
  areMacUpdateVersionsEqual,
  clearMacUpdateInstallAttempt,
  clearMacUpdateInstallHeartbeat,
  failMacUpdateInstallAttemptIfCurrent,
  getMacUpdateProcessIdentityState,
  isMatchingBundleShipItRunning,
  MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
  readMacUpdateInstallAttempt,
  writeMacUpdateInstallHeartbeat,
  type MacUpdateInstallAttempt,
  type MacUpdateInstallFailureReason
} from './mac-update-install-attempt'

export const MAC_UPDATE_MONITOR_POLL_MS = 2_000
export const MAC_UPDATE_MONITOR_SHIPIT_APPEARANCE_MS = 30_000
export const MAC_UPDATE_MONITOR_SHIPIT_EXIT_GRACE_MS = 5_000
export const MAC_UPDATE_MONITOR_TIMEOUT_MS = 15 * 60_000

/**
 * Every probe is tri-state: only a verified observation may drive a failure decision. A ps or
 * filesystem hiccup must never relaunch the old app into ShipIt's install window.
 */
type MonitorObservation = {
  bundleVersion: string | null
  shipIt: 'alive' | 'absent' | 'unknown'
  source: 'alive' | 'dead' | 'unverifiable'
}

export type MacUpdateMonitorDecision =
  | { action: 'continue'; shipItSeen: boolean; shipItMissingSinceMs: number | null }
  | { action: 'complete' }
  | { action: 'fail'; reason: MacUpdateInstallFailureReason }

export function decideMacUpdateMonitorStep(options: {
  attempt: MacUpdateInstallAttempt
  observation: MonitorObservation
  nowMs: number
  shipItSeen: boolean
  shipItMissingSinceMs: number | null
  /** First verified source-dead observation; the appearance window must not start earlier. */
  sourceDeadSinceMs?: number | null
}): MacUpdateMonitorDecision {
  const { attempt, observation, nowMs } = options
  if (
    observation.bundleVersion !== null &&
    areMacUpdateVersionsEqual(observation.bundleVersion, attempt.targetVersion)
  ) {
    return { action: 'complete' }
  }
  if (nowMs - attempt.createdAtMs >= MAC_UPDATE_MONITOR_TIMEOUT_MS) {
    return { action: 'fail', reason: 'install-timed-out' }
  }
  const shipItSeen = options.shipItSeen || observation.shipIt === 'alive'
  // Why not-dead rather than alive: an unverifiable source may still be quitting; failing early
  // could relaunch the old app straight into ShipIt's install window.
  if (observation.source !== 'dead') {
    return { action: 'continue', shipItSeen, shipItMissingSinceMs: null }
  }
  if (observation.shipIt === 'alive') {
    return { action: 'continue', shipItSeen: true, shipItMissingSinceMs: null }
  }
  if (observation.shipIt === 'unknown') {
    // Why: an unverified process list neither confirms nor refutes ShipIt; freeze the clocks.
    return { action: 'continue', shipItSeen, shipItMissingSinceMs: options.shipItMissingSinceMs }
  }
  if (!shipItSeen) {
    // Why the max: a wedged teardown can hold the source alive until the 20s exit watchdog,
    // eating most of the appearance window. Launchd deserves the full window measured from
    // when the source verifiably died, or a slow quit turns into a relaunch into ShipIt.
    const appearanceBaselineMs = Math.max(
      attempt.createdAtMs,
      options.sourceDeadSinceMs ?? attempt.createdAtMs
    )
    if (nowMs - appearanceBaselineMs >= MAC_UPDATE_MONITOR_SHIPIT_APPEARANCE_MS) {
      return { action: 'fail', reason: 'installer-never-started' }
    }
    return { action: 'continue', shipItSeen: false, shipItMissingSinceMs: null }
  }
  const missingSinceMs = options.shipItMissingSinceMs ?? nowMs
  if (nowMs - missingSinceMs >= MAC_UPDATE_MONITOR_SHIPIT_EXIT_GRACE_MS) {
    return { action: 'fail', reason: 'installer-exited-with-source-version' }
  }
  return { action: 'continue', shipItSeen: true, shipItMissingSinceMs: missingSinceMs }
}

export async function runMacUpdateInstallMonitor(options: {
  attemptPath: string
  attemptId: string
  now?: () => number
  wait?: (durationMs: number) => Promise<void>
  observe?: (attempt: MacUpdateInstallAttempt) => Promise<MonitorObservation>
  launchRecovery?: (attempt: MacUpdateInstallAttempt) => Promise<boolean>
}): Promise<'completed' | 'failed' | 'cancelled'> {
  const now = options.now ?? Date.now
  const wait = options.wait ?? waitFor
  let attempt = await waitForAttempt(options.attemptPath, options.attemptId, wait)
  if (!attempt) {
    return 'cancelled'
  }
  let shipItSeen = false
  let shipItMissingSinceMs: number | null = null
  let sourceDeadSinceMs: number | null = null

  for (;;) {
    const current = readMacUpdateInstallAttempt(options.attemptPath)
    if (!current || current.attemptId !== options.attemptId || current.phase !== 'installing') {
      clearMacUpdateInstallHeartbeat(options.attemptPath, options.attemptId)
      return 'cancelled'
    }
    attempt = current
    const nowMs = now()
    const observation = await (options.observe ?? observeInstall)(attempt)
    if (observation.source === 'dead') {
      sourceDeadSinceMs ??= nowMs
    } else if (observation.source === 'alive') {
      sourceDeadSinceMs = null
    }
    const decision = decideMacUpdateMonitorStep({
      attempt,
      observation,
      nowMs,
      shipItSeen,
      shipItMissingSinceMs,
      sourceDeadSinceMs
    })
    if (decision.action === 'complete') {
      clearMacUpdateInstallAttempt(options.attemptPath, attempt.attemptId)
      return 'completed'
    }
    if (decision.action === 'fail') {
      // Why a confirm probe: the failing observation is up to a poll old, and launching
      // recovery against a live ShipIt would relaunch the old app into the install window —
      // the exact race this monitor exists to prevent. A late completion wins outright.
      const confirm = await (options.observe ?? observeInstall)(attempt)
      if (
        confirm.bundleVersion !== null &&
        areMacUpdateVersionsEqual(confirm.bundleVersion, attempt.targetVersion)
      ) {
        clearMacUpdateInstallAttempt(options.attemptPath, attempt.attemptId)
        return 'completed'
      }
      if (decision.reason !== 'install-timed-out' && confirm.shipIt !== 'absent') {
        if (confirm.shipIt === 'alive') {
          shipItSeen = true
          shipItMissingSinceMs = null
        }
        // Why unknown re-polls untouched: an unverified list neither confirms the failure nor
        // proves ShipIt was ever seen; freeze the clocks and let the next verified probe decide.
        writeMacUpdateInstallHeartbeat(options.attemptPath, {
          schemaVersion: MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
          attemptId: attempt.attemptId,
          heartbeatAtMs: nowMs
        })
        await wait(MAC_UPDATE_MONITOR_POLL_MS)
        continue
      }
      // Why guarded: cleanup may have cleared or replaced the attempt while this step observed;
      // writing an unconditional failure would resurrect a finished attempt and launch a
      // recovery app nobody asked for.
      const failed = failMacUpdateInstallAttemptIfCurrent(options.attemptPath, attempt.attemptId, {
        failureReason: decision.reason,
        nowMs
      })
      if (!failed) {
        clearMacUpdateInstallHeartbeat(options.attemptPath, attempt.attemptId)
        return 'cancelled'
      }
      await (options.launchRecovery ?? launchRecoveryApp)(failed)
      return 'failed'
    }
    shipItSeen = decision.shipItSeen
    shipItMissingSinceMs = decision.shipItMissingSinceMs
    // Why a sibling file: the recurring heartbeat write must never be able to resurrect or
    // clobber the attempt record itself after startup cleanup cleared or replaced it.
    writeMacUpdateInstallHeartbeat(options.attemptPath, {
      schemaVersion: MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
      attemptId: attempt.attemptId,
      heartbeatAtMs: nowMs
    })
    await wait(MAC_UPDATE_MONITOR_POLL_MS)
  }
}

async function waitForAttempt(
  attemptPath: string,
  attemptId: string,
  wait: (durationMs: number) => Promise<void>
): Promise<MacUpdateInstallAttempt | null> {
  for (let index = 0; index < 20; index += 1) {
    const attempt = readMacUpdateInstallAttempt(attemptPath)
    if (attempt?.attemptId === attemptId) {
      return attempt
    }
    await wait(100)
  }
  return null
}

async function observeInstall(attempt: MacUpdateInstallAttempt): Promise<MonitorObservation> {
  const [bundleVersion, processList] = await Promise.all([
    readBundleVersion(attempt.targetBundlePath),
    readProcessList()
  ])
  return {
    bundleVersion,
    shipIt:
      processList === null
        ? 'unknown'
        : isMatchingBundleShipItRunning(attempt.targetBundlePath, processList)
          ? 'alive'
          : 'absent',
    source: getMacUpdateProcessIdentityState(attempt.sourcePid, attempt.sourceStartedAtMs)
  }
}

async function readBundleVersion(bundlePath: string): Promise<string | null> {
  try {
    const plist = await readFile(join(bundlePath, 'Contents', 'Info.plist'), 'utf8')
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    return match?.[1]?.trim() || null
  } catch {
    return null
  }
}

/** null means the probe itself failed — callers must treat that as unknown, not as absence. */
async function readProcessList(): Promise<string | null> {
  try {
    const result = await runProcess({
      program: '/bin/ps',
      args: ['-ww', '-axo', 'command='],
      timeoutMs: 2_000,
      maxOutputBytes: 16 * 1024 * 1024
    })
    return result.code === 0 ? result.stdout : null
  } catch {
    return null
  }
}

async function launchRecoveryApp(attempt: MacUpdateInstallAttempt): Promise<boolean> {
  try {
    const child = spawnProcess({
      program: '/usr/bin/open',
      args: [attempt.targetBundlePath, '--args', `--update-install-recovery=${attempt.attemptId}`],
      detached: true,
      stdio: 'ignore'
    })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

function waitFor(durationMs: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, durationMs))
}
