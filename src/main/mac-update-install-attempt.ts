import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compareAppVersions, isValidAppVersion } from '../shared/app-version'
import { spawnProcess } from '../shared/child-process/run-process'
import { getProcessStartedAtMs } from './daemon/daemon-process-start-time'
import {
  getMacUpdateProcessIdentityState,
  isMatchingBundleShipItRunning,
  readAllProcessCommands,
  type MacUpdateShipItState
} from './mac-update-install-process-probes'
export {
  getMacUpdateProcessIdentityState,
  isMacUpdateProcessIdentityAlive,
  isMatchingBundleShipItRunning,
  type MacUpdateProcessIdentityState,
  type MacUpdateShipItState
} from './mac-update-install-process-probes'
import {
  clearMacUpdateInstallAttempt,
  clearMacUpdateInstallHeartbeat,
  getMacUpdateInstallAttemptPath,
  MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
  readMacUpdateInstallAttempt,
  readMacUpdateInstallHeartbeat,
  writeMacUpdateInstallAttempt,
  type MacUpdateInstallAttempt,
  type MacUpdateInstallRecoveryReason
} from './mac-update-install-attempt-store'
export {
  MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
  clearMacUpdateInstallAttempt,
  clearMacUpdateInstallHeartbeat,
  failMacUpdateInstallAttemptIfCurrent,
  getMacUpdateInstallAttemptPath,
  getMacUpdateInstallHeartbeatPath,
  readMacUpdateInstallAttempt,
  readMacUpdateInstallHeartbeat,
  writeMacUpdateInstallAttempt,
  writeMacUpdateInstallHeartbeat,
  type MacUpdateInstallAttempt,
  type MacUpdateInstallFailureReason,
  type MacUpdateInstallHeartbeat,
  type MacUpdateInstallRecoveryReason
} from './mac-update-install-attempt-store'

export const MAC_UPDATE_INSTALL_ATTEMPT_STALE_MS = 15_000
export const MAC_UPDATE_INSTALL_ATTEMPT_MAX_AGE_MS = 15 * 60_000

export const MAC_UPDATE_INSTALL_MONITOR_ENTRY = 'mac-update-install-monitor-entry.js'
const MONITOR_IDENTITY_SANITY_WINDOW_MS = 30_000

export type MacUpdateInstallLaunchDecision =
  | { action: 'allow'; reason: 'different-bundle' | 'no-attempt' }
  | { action: 'allow-and-clear'; reason: 'target-installed' }
  | {
      action: 'allow-with-failure'
      reason: 'install-abandoned' | 'recorded-failure'
      failureReason: MacUpdateInstallRecoveryReason
    }
  | { action: 'block'; reason: 'active-install' | 'shipit-alive' | 'shipit-unverifiable' }

/**
 * Canonical version equality: a feed may carry a leading `v` or build metadata while the
 * bundle plist is bare. A successful install must never read as a failure over formatting.
 */
export function areMacUpdateVersionsEqual(left: string, right: string): boolean {
  if (left === right) {
    return true
  }
  return (
    isValidAppVersion(left) && isValidAppVersion(right) && compareAppVersions(left, right) === 0
  )
}

export function resolveMacUpdateBundlePath(executablePath: string): string {
  const bundlePath = resolve(executablePath, '..', '..', '..')
  if (!bundlePath.toLowerCase().endsWith('.app')) {
    throw new Error('The updater executable is not inside a macOS app bundle')
  }
  return bundlePath
}

export function decideMacUpdateInstallLaunch(options: {
  attempt: MacUpdateInstallAttempt | null
  currentBundlePath: string
  currentVersion: string
  nowMs: number
  monitorAlive: boolean
  /** Verified-only: an unknown process list must never read as ShipIt absence. */
  shipIt: MacUpdateShipItState
  /** Freshest known monitor heartbeat; defaults to the attempt record's own field. */
  effectiveHeartbeatAtMs?: number
}): MacUpdateInstallLaunchDecision {
  const { attempt } = options
  if (!attempt) {
    return { action: 'allow', reason: 'no-attempt' }
  }
  if (!macPathsEqual(attempt.targetBundlePath, options.currentBundlePath)) {
    return { action: 'allow', reason: 'different-bundle' }
  }
  if (areMacUpdateVersionsEqual(options.currentVersion, attempt.targetVersion)) {
    return { action: 'allow-and-clear', reason: 'target-installed' }
  }
  // Why clamped: a backward wall-clock step during the handoff must not disable the liveness
  // checks below and relaunch the old bundle into a live ShipIt.
  const ageMs = Math.max(0, options.nowMs - attempt.createdAtMs)
  if (attempt.phase === 'failed') {
    return {
      action: 'allow-with-failure',
      reason: 'recorded-failure',
      failureReason: attempt.failureReason ?? 'monitor-exited'
    }
  }
  if (ageMs > MAC_UPDATE_INSTALL_ATTEMPT_MAX_AGE_MS) {
    return {
      action: 'allow-with-failure',
      reason: 'install-abandoned',
      failureReason: 'install-timed-out'
    }
  }
  if (options.monitorAlive) {
    return { action: 'block', reason: 'active-install' }
  }
  if (options.shipIt === 'alive') {
    return { action: 'block', reason: 'shipit-alive' }
  }
  if (options.shipIt === 'unknown') {
    // Why: only a verified process list may clear the way; the age cap above bounds this block.
    return { action: 'block', reason: 'shipit-unverifiable' }
  }
  const heartbeatAtMs = Math.max(options.effectiveHeartbeatAtMs ?? 0, attempt.heartbeatAtMs)
  // Why abs: after a backward clock step a heartbeat from the "future" is not proof of life;
  // only a heartbeat within the stale window on either side keeps the fence up.
  if (Math.abs(options.nowMs - heartbeatAtMs) <= MAC_UPDATE_INSTALL_ATTEMPT_STALE_MS) {
    return { action: 'block', reason: 'active-install' }
  }
  return {
    action: 'allow-with-failure',
    reason: 'install-abandoned',
    failureReason: 'monitor-exited'
  }
}

export function armMacUpdateInstallAttempt(options: {
  appDataPath: string
  executablePath: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  resourcesPath: string
  sourceVersion: string
  targetVersion: string
  nowMs?: number
  readProcessStartedAtMs?: (pid: number) => number | null
}): MacUpdateInstallAttempt | null {
  if ((options.platform ?? process.platform) !== 'darwin' || !options.isPackaged) {
    return null
  }
  if (!isValidAppVersion(options.sourceVersion) || !isValidAppVersion(options.targetVersion)) {
    throw new Error('The macOS update attempt requires valid source and target versions')
  }
  const readStartedAtMs = options.readProcessStartedAtMs ?? getProcessStartedAtMs
  const sourceStartedAtMs = readStartedAtMs(process.pid)
  if (sourceStartedAtMs === null) {
    throw new Error('Could not identify the macOS update source process')
  }
  const attemptId = randomUUID()
  const attemptPath = getMacUpdateInstallAttemptPath(options.appDataPath)
  const monitorEntry = join(
    options.resourcesPath,
    'app.asar.unpacked',
    'out',
    'main',
    MAC_UPDATE_INSTALL_MONITOR_ENTRY
  )
  if (!existsSync(monitorEntry)) {
    throw new Error('The macOS update monitor is missing from the app bundle')
  }
  const monitor = spawnProcess({
    program: options.executablePath,
    args: [monitorEntry, attemptPath, attemptId],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore'
  })
  monitor.on('error', () => {})
  if (!monitor.pid) {
    throw new Error('Could not start the macOS update monitor')
  }
  monitor.unref()
  const nowMs = options.nowMs ?? Date.now()
  const monitorStartedAtMs = readStartedAtMs(monitor.pid)
  if (monitorStartedAtMs === null) {
    throw new Error('Could not identify the macOS update monitor process')
  }
  // Why: a just-spawned child whose recorded start time is far from now is not our monitor
  // (instant exit + pid reuse). Better to install unfenced than to fence on a stranger.
  if (Math.abs(monitorStartedAtMs - nowMs) > MONITOR_IDENTITY_SANITY_WINDOW_MS) {
    throw new Error('The macOS update monitor identity did not match the spawned process')
  }
  const attempt: MacUpdateInstallAttempt = {
    schemaVersion: MAC_UPDATE_INSTALL_ATTEMPT_SCHEMA_VERSION,
    attemptId,
    sourceVersion: options.sourceVersion,
    targetVersion: options.targetVersion,
    targetBundlePath: resolveMacUpdateBundlePath(options.executablePath),
    sourcePid: process.pid,
    sourceStartedAtMs,
    monitorPid: monitor.pid,
    monitorStartedAtMs,
    phase: 'installing',
    createdAtMs: nowMs,
    heartbeatAtMs: nowMs
  }
  writeMacUpdateInstallAttempt(attemptPath, attempt)
  return attempt
}

export function resolveMacUpdateInstallStartup(options: {
  appDataPath: string
  appVersion: string
  executablePath: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  nowMs?: number
  readProcessStartedAtMs?: (pid: number) => number | null
  readProcessList?: () => string | null
}): MacUpdateInstallLaunchDecision {
  // Why fail-open: this runs on every packaged launch; an unexpected error must never block or
  // crash startup — worst case the launch proceeds exactly as it did before the fence existed.
  try {
    return resolveMacUpdateInstallStartupUnsafe(options)
  } catch (error) {
    console.warn(
      `[updater] macOS install-fence startup probe failed open: ${error instanceof Error ? error.message : String(error)}`
    )
    return { action: 'allow', reason: 'no-attempt' }
  }
}

function resolveMacUpdateInstallStartupUnsafe(options: {
  appDataPath: string
  appVersion: string
  executablePath: string
  isPackaged: boolean
  platform?: NodeJS.Platform
  nowMs?: number
  readProcessStartedAtMs?: (pid: number) => number | null
  readProcessList?: () => string | null
}): MacUpdateInstallLaunchDecision {
  if ((options.platform ?? process.platform) !== 'darwin' || !options.isPackaged) {
    return { action: 'allow', reason: 'no-attempt' }
  }
  const attemptPath = getMacUpdateInstallAttemptPath(options.appDataPath)
  const attempt = readMacUpdateInstallAttempt(attemptPath)
  if (!attempt) {
    // Why: a heartbeat with no attempt record is an orphan from a lost race; reclaim it.
    clearMacUpdateInstallHeartbeat(attemptPath)
    return { action: 'allow', reason: 'no-attempt' }
  }
  const monitorAlive =
    getMacUpdateProcessIdentityState(
      attempt.monitorPid,
      attempt.monitorStartedAtMs,
      options.readProcessStartedAtMs
    ) !== 'dead'
  let shipIt: MacUpdateShipItState = 'absent'
  if (!monitorAlive) {
    try {
      const processList = (options.readProcessList ?? readAllProcessCommands)()
      shipIt =
        processList === null
          ? 'unknown'
          : isMatchingBundleShipItRunning(attempt.targetBundlePath, processList)
            ? 'alive'
            : 'absent'
    } catch {
      shipIt = 'unknown'
    }
  }
  const heartbeat = readMacUpdateInstallHeartbeat(attemptPath)
  const decision = decideMacUpdateInstallLaunch({
    attempt,
    currentBundlePath: resolveMacUpdateBundlePath(options.executablePath),
    currentVersion: options.appVersion,
    nowMs: options.nowMs ?? Date.now(),
    monitorAlive,
    shipIt,
    effectiveHeartbeatAtMs:
      heartbeat && heartbeat.attemptId === attempt.attemptId ? heartbeat.heartbeatAtMs : undefined
  })
  if (decision.action === 'allow-and-clear' || decision.action === 'allow-with-failure') {
    clearMacUpdateInstallAttempt(attemptPath, attempt.attemptId)
  }
  return decision
}

function macPathsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    resolve(value)
      .replace(/^\/System\/Volumes\/Data(?=\/)/i, '')
      .normalize('NFC')
      .toLocaleLowerCase('en-US')
  return normalize(left) === normalize(right)
}
