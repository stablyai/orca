// Records whether each main-process launch ended through a known exit path, so
// the next launch can tell a native main-process death (which never delivers
// process-gone and writes no breadcrumb) from a user quit.
//
// Two files so the throttled activity write and the exit write never race over
// one path: a stale activity rename cannot clobber an exit record.

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MainProcessLifecycleIdentity } from './main-process-lifecycle-identity'

export const MAIN_SESSION_LAUNCH_FILE = 'main-session-launch.json'
export const MAIN_SESSION_EXIT_FILE = 'main-session-exit.json'
const SCHEMA_VERSION = 1
// Bounds when an unmarked session died without a write per breadcrumb.
const ACTIVITY_WRITE_INTERVAL_MS = 60_000
// Why 5 min: outlasts systemd's 90s stop timeout and macOS logout, so only a cancelled shutdown revokes.
export const PROVISIONAL_EXIT_REVOKE_MS = 5 * 60_000

export type MainSessionExitKind =
  | 'quit'
  | 'update-install'
  | 'relaunch'
  | 'os-session-end'
  | 'os-shutdown'

type LaunchRecord = {
  schemaVersion: typeof SCHEMA_VERSION
  launchId: string
  pid: number
  startedAt: string
  appVersion: string
  lastBreadcrumbAt?: string
}

type ExitRecord = {
  schemaVersion: typeof SCHEMA_VERSION
  launchId: string
  kind: MainSessionExitKind
  exitedAt: string
}

export type PreviousUncleanMainSession = Readonly<{
  launchId: string
  pid: number
  startedAt: string
  appVersion: string
  lastBreadcrumbAt: string | null
}>

export type PreviousSessionCrashpadDump = Readonly<{
  writtenAt: string
  sizeBytes: number
  processType: string | null
  dumpCount: number
}>

type TrackingState = {
  launchPath: string
  exitPath: string
  launch: LaunchRecord
}

let tracking: TrackingState | null = null
// Why provisional: an OS shutdown notice can still be cancelled, so it must not latch like a committed quit.
let recordedExit: { kind: MainSessionExitKind; provisional: boolean } | null = null
let provisionalRevokeTimer: NodeJS.Timeout | null = null
// Why: a relaunch that exits via app.quit() names the exit now but commits it after teardown.
let pendingExitLabel: MainSessionExitKind | null = null
let launchWriteChain: Promise<void> = Promise.resolve()
let lastActivityWriteAtMs = Number.NEGATIVE_INFINITY
let activityTimer: NodeJS.Timeout | null = null

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null
  } catch {
    return null
  }
}

function readLaunchRecord(filePath: string): LaunchRecord | null {
  const raw = readJsonObject(filePath)
  if (
    !raw ||
    raw.schemaVersion !== SCHEMA_VERSION ||
    typeof raw.launchId !== 'string' ||
    typeof raw.pid !== 'number' ||
    typeof raw.startedAt !== 'string' ||
    typeof raw.appVersion !== 'string'
  ) {
    return null
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    launchId: raw.launchId,
    pid: raw.pid,
    startedAt: raw.startedAt,
    appVersion: raw.appVersion,
    ...(typeof raw.lastBreadcrumbAt === 'string' ? { lastBreadcrumbAt: raw.lastBreadcrumbAt } : {})
  }
}

function readExitLaunchId(filePath: string): string | null {
  const raw = readJsonObject(filePath)
  return raw?.schemaVersion === SCHEMA_VERSION && typeof raw.launchId === 'string'
    ? raw.launchId
    : null
}

function tempPathFor(filePath: string): string {
  return `${filePath}.${process.pid}.tmp`
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value)
  const tempPath = tempPathFor(filePath)
  try {
    await writeFile(tempPath, body)
    await rename(tempPath, filePath)
  } catch {
    // Why: Windows can refuse the replace while a scanner holds the target; a torn
    // direct write is still better evidence than none.
    await writeFile(filePath, body).catch(() => {})
  }
}

function writeJsonAtomicallySync(filePath: string, value: unknown): void {
  const body = JSON.stringify(value)
  const tempPath = tempPathFor(filePath)
  try {
    writeFileSync(tempPath, body)
    renameSync(tempPath, filePath)
  } catch {
    try {
      writeFileSync(filePath, body)
    } catch {
      // Best effort: a missing exit record only costs a false unclean report.
    }
  }
}

function enqueueLaunchWrite(): Promise<void> {
  const state = tracking
  if (!state) {
    return launchWriteChain
  }
  launchWriteChain = launchWriteChain.then(() =>
    writeJsonAtomically(state.launchPath, { ...state.launch })
  )
  return launchWriteChain
}

/**
 * Reads the previous launch's records, then starts tracking this launch.
 * Must run after the single-instance lock so a losing second instance cannot
 * overwrite the running launch's record. Returns the previous launch only when
 * it ended without a recorded exit.
 */
export function beginMainSessionTracking({
  userDataPath,
  identity,
  appVersion
}: {
  userDataPath: string
  identity: MainProcessLifecycleIdentity
  appVersion: string
}): PreviousUncleanMainSession | null {
  const launchPath = path.join(userDataPath, MAIN_SESSION_LAUNCH_FILE)
  const exitPath = path.join(userDataPath, MAIN_SESSION_EXIT_FILE)
  const previous = readLaunchRecord(launchPath)
  const previousExitLaunchId = readExitLaunchId(exitPath)
  tracking = {
    launchPath,
    exitPath,
    launch: {
      schemaVersion: SCHEMA_VERSION,
      launchId: identity.mainProcessLaunchId,
      pid: identity.mainProcessPid,
      startedAt: identity.mainProcessStartedAt,
      appVersion
    }
  }
  recordedExit = null
  pendingExitLabel = null
  clearProvisionalRevokeTimer()
  void enqueueLaunchWrite()
  if (
    !previous ||
    previous.launchId === identity.mainProcessLaunchId ||
    previousExitLaunchId === previous.launchId
  ) {
    return null
  }
  return {
    launchId: previous.launchId,
    pid: previous.pid,
    startedAt: previous.startedAt,
    appVersion: previous.appVersion,
    lastBreadcrumbAt: previous.lastBreadcrumbAt ?? null
  }
}

function isExitCommitted(): boolean {
  return recordedExit !== null && !recordedExit.provisional
}

function clearProvisionalRevokeTimer(): void {
  if (provisionalRevokeTimer) {
    clearTimeout(provisionalRevokeTimer)
    provisionalRevokeTimer = null
  }
}

function flushActivity(): void {
  activityTimer = null
  if (!tracking || isExitCommitted()) {
    return
  }
  lastActivityWriteAtMs = Date.now()
  void enqueueLaunchWrite()
}

/** Throttled: keeps the launch record's last-activity time within one interval of death. */
export function noteMainSessionActivity(createdAt: string): void {
  if (!tracking || isExitCommitted()) {
    return
  }
  tracking.launch.lastBreadcrumbAt = createdAt
  if (activityTimer) {
    return
  }
  const waitMs = lastActivityWriteAtMs + ACTIVITY_WRITE_INTERVAL_MS - Date.now()
  if (waitMs <= 0) {
    flushActivity()
    return
  }
  activityTimer = setTimeout(flushActivity, waitMs)
  activityTimer.unref()
}

function buildExitRecord(kind: MainSessionExitKind): ExitRecord | null {
  return tracking
    ? {
        schemaVersion: SCHEMA_VERSION,
        launchId: tracking.launch.launchId,
        kind,
        exitedAt: new Date().toISOString()
      }
    : null
}

function takeExitRecord(kind: MainSessionExitKind): { path: string; record: ExitRecord } | null {
  // Why first-wins: relaunch/session-end/shutdown label the exit before the will-quit that may follow.
  if (!tracking || isExitCommitted()) {
    return null
  }
  const label = recordedExit?.kind ?? pendingExitLabel ?? kind
  recordedExit = { kind: label, provisional: false }
  clearProvisionalRevokeTimer()
  if (activityTimer) {
    clearTimeout(activityTimer)
    activityTimer = null
  }
  const record = buildExitRecord(label)
  return record ? { path: tracking.exitPath, record } : null
}

/**
 * Names the exit without recording it, for a quit whose will-quit teardown will
 * commit the record; a crash before then must still read as unclean.
 */
export function labelMainSessionExit(kind: MainSessionExitKind): void {
  if (tracking && !isExitCommitted()) {
    pendingExitLabel = kind
  }
}

/** For committed quits that can await teardown (will-quit). */
export function recordMainSessionExit(kind: MainSessionExitKind): Promise<void> {
  const exit = takeExitRecord(kind)
  return exit ? writeJsonAtomically(exit.path, exit.record) : Promise.resolve()
}

/** For exits that may end the process before an async write lands (app.exit, OS teardown). */
export function recordMainSessionExitSync(kind: MainSessionExitKind): void {
  const exit = takeExitRecord(kind)
  if (exit) {
    writeJsonAtomicallySync(exit.path, exit.record)
  }
}

/**
 * For an exit notice that can still be cancelled (OS shutdown/logout request).
 * Written now because the OS may end the process without will-quit; revoked if
 * the quit is aborted or the process is still alive after the revoke window.
 */
export function recordProvisionalMainSessionExitSync(
  kind: MainSessionExitKind,
  revokeAfterMs: number = PROVISIONAL_EXIT_REVOKE_MS
): void {
  const state = tracking
  if (!state || recordedExit) {
    return
  }
  const record = buildExitRecord(kind)
  if (!record) {
    return
  }
  recordedExit = { kind, provisional: true }
  writeJsonAtomicallySync(state.exitPath, record)
  provisionalRevokeTimer = setTimeout(revokeProvisionalMainSessionExit, revokeAfterMs)
  provisionalRevokeTimer.unref()
}

/** Call when a quit is aborted; a later crash in this launch must still read as unclean. */
export function revokeProvisionalMainSessionExit(): void {
  if (!tracking || !recordedExit?.provisional) {
    return
  }
  clearProvisionalRevokeTimer()
  recordedExit = null
  try {
    // Why sync: an async remove could land after a later committed exit write and erase it.
    rmSync(tracking.exitPath, { force: true })
  } catch {
    // Best effort: a stale exit record only hides one unclean report.
  }
}

export function _resetMainSessionTrackingForTest(): void {
  if (activityTimer) {
    clearTimeout(activityTimer)
  }
  clearProvisionalRevokeTimer()
  tracking = null
  recordedExit = null
  pendingExitLabel = null
  launchWriteChain = Promise.resolve()
  lastActivityWriteAtMs = Number.NEGATIVE_INFINITY
  activityTimer = null
}

export function _awaitMainSessionWritesForTest(): Promise<void> {
  return launchWriteChain
}
