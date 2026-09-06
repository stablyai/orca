import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  decideMacUpdateLaunch,
  getSettledMacUpdateInstallMarkerFileName,
  isAttemptInFlight,
  getMacUpdateInstallMarkerPath,
  readMacUpdateInstallMarkers,
  resolveMacAppBundlePath,
  createAttemptId,
  isMarkerExpired,
  selectActiveMarker,
  selectInFlightMarker,
  type MacUpdateInstallMarker
} from '../shared/mac-update-install-marker'
import {
  getProcessStartTimes,
  getShipItLivenessForBundle,
  isRecordedProcessAlive
} from '../shared/shipit-liveness'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'

/**
 * Publish "an install is in flight for this bundle" where a launching process can see it.
 *
 * It has to outlive this process: the whole failure is that we exit, ShipIt waits for the
 * bundle to go quiet, and something reopens the old version before the swap lands — so the
 * process that knows about the install is exactly the one that is gone.
 */
export function markMacUpdateInstallInFlight(targetVersion: string): void {
  const bundlePath = resolveMacAppBundlePath(process.execPath)
  if (!bundlePath || !targetVersion) {
    return
  }
  const createdAtMs = Date.now()
  // The kernel value survives later wall-clock changes; uptime math is only a fail-open fallback
  // when the bounded identity probe is unavailable during shutdown.
  const observedProcessStart = getProcessStartTimes([process.pid])?.get(process.pid)
  const marker: MacUpdateInstallMarker = {
    schemaVersion: 1,
    bundlePath,
    fromVersion: app.getVersion(),
    targetVersion,
    requestedByPid: process.pid,
    requestedByStartedAtMs:
      observedProcessStart ?? Math.max(1, Math.round(createdAtMs - process.uptime() * 1_000)),
    createdAtMs,
    attemptId: createAttemptId()
  }
  const markerPath = getMacUpdateInstallMarkerPath(bundlePath, marker)
  try {
    mkdirSync(dirname(markerPath), { recursive: true })
    // Why temp+rename: a launching process must never read a half-written marker and conclude it
    // is corrupt, which would fail open into the very race this closes.
    const tempPath = `${markerPath}.${process.pid}.tmp`
    writeFileSync(tempPath, JSON.stringify(marker), 'utf8')
    renameSync(tempPath, markerPath)
    ownedMarkerPath = markerPath
    pruneExpiredMarkers(dirname(markerPath), marker.createdAtMs)
    recordUpdaterLifecycle('mac_install_marker_written', { targetVersion })
  } catch {
    // Why swallow: the marker is a race guard, not a precondition. Failing to write it must never
    // block an install that would otherwise succeed.
  }
}

// Why track the exact file: deletion must remove only what this process wrote. A newer attempt
// lives under a different name, so it can never be the thing an older owner unlinks.
let ownedMarkerPath: string | null = null

function isOwnedMarker(bundlePath: string, marker: MacUpdateInstallMarker): boolean {
  return getMacUpdateInstallMarkerPath(bundlePath, marker) === ownedMarkerPath
}

/**
 * Drop attempt files older than the age cap.
 *
 * Per-attempt filenames are what make deletion safe, but they also mean a crashed attempt leaves
 * its file behind forever. Anything past the cap is already ignored by `decideMacUpdateLaunch`,
 * so removing it changes no decision — it just stops the directory growing without bound.
 * Deliberately only prunes what is provably expired, never a marker that might still be live.
 */
function pruneExpiredMarkers(dir: string, now: number): void {
  try {
    for (const name of readdirSync(dir)) {
      // Both prefixes: `settled-` files are reported-on attempts kept only so their outcome is
      // not logged twice, and expiry is what reclaims them.
      const match = /^(?:attempt|settled)-(\d+)-\d+-[0-9a-f]{16}\.json$/.exec(name)
      if (!match) {
        continue
      }
      const createdAtMs = Number(match[1])
      if (
        Number.isFinite(createdAtMs) &&
        isMarkerExpired({ createdAtMs } as MacUpdateInstallMarker, now)
      ) {
        try {
          unlinkSync(join(dir, name))
        } catch {
          // Another process may have cleaned it up first.
        }
      }
    }
  } catch {
    // A missing or unreadable directory needs no pruning.
  }
}

function readActiveMarkersForThisBundle(): MacUpdateInstallMarker[] {
  const bundlePath = resolveMacAppBundlePath(process.execPath)
  if (!bundlePath) {
    return []
  }
  const now = Date.now()
  return readMacUpdateInstallMarkers(bundlePath, {
    list: (dir) => readdirSync(dir),
    readFile: (path) => readFileSync(path, 'utf8')
  }).filter((marker) => !isMarkerExpired(marker, now))
}

function readNewestMarkerForThisBundle(): MacUpdateInstallMarker | null {
  const bundlePath = resolveMacAppBundlePath(process.execPath)
  if (!bundlePath) {
    return null
  }
  return selectActiveMarker(
    readMacUpdateInstallMarkers(bundlePath, {
      list: (dir) => readdirSync(dir),
      readFile: (path) => readFileSync(path, 'utf8')
    }),
    Date.now()
  )
}

/** Whether an update install is currently in flight for this bundle. */
export function isMacUpdateInstallInFlight(): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  const bundlePath = resolveMacAppBundlePath(process.execPath)
  if (!bundlePath) {
    return false
  }
  try {
    const now = Date.now()
    const markers = readActiveMarkersForThisBundle()
    if (markers.length === 0) {
      return false
    }
    let shipItLiveness: 'live' | 'unverifiable' | 'exited' | undefined
    const processStarts = getProcessStartTimes(
      markers
        .filter((marker) => !isOwnedMarker(bundlePath, marker))
        .map((marker) => marker.requestedByPid)
    )
    // Why inspect every attempt: a dead newer marker can otherwise mask an older writer that is
    // still in the pre-spawn window and must keep relaunches out of the bundle.
    return Boolean(
      selectInFlightMarker(markers, now, (marker) => {
        // This process is authoritative for the exact marker it successfully published. Re-probing
        // its own PID can time out during shutdown and misclassify a live pre-spawn handoff as dead.
        const writerAlive =
          isOwnedMarker(bundlePath, marker) ||
          isRecordedProcessAlive(
            marker.requestedByPid,
            marker.requestedByStartedAtMs,
            processStarts
          )
        return isAttemptInFlight({
          marker,
          now,
          shipItLiveness: writerAlive
            ? 'exited'
            : (shipItLiveness ??= getShipItLivenessForBundle(bundlePath)),
          writerAlive
        })
      })
    )
  } catch {
    return false
  }
}

/**
 * Drop the marker once this bundle is no longer mid-install.
 *
 * `expected` makes this a compare-and-delete: reconciliation reads the marker, then clears it,
 * and a newer install committed in between must survive — deleting it would leave the next launch
 * free to cancel that install.
 */
export function settleMacUpdateInstallMarker(marker: MacUpdateInstallMarker): void {
  const bundlePath = resolveMacAppBundlePath(process.execPath)
  if (!bundlePath) {
    return
  }
  const from = getMacUpdateInstallMarkerPath(bundlePath, marker)
  const to = join(dirname(from), getSettledMacUpdateInstallMarkerFileName(marker))
  try {
    // Rename by exact name is as race-safe as unlink by exact name, and it cannot remove another
    // attempt's file. Readers ignore `settled-`; expiry reclaims it later.
    renameSync(from, to)
  } catch {
    // Already settled, or never written.
  }
}

/** Withdraw an attempt this process wrote but never handed to the installer. */
export function clearMacUpdateInstallMarker(marker?: MacUpdateInstallMarker): void {
  const bundlePath = resolveMacAppBundlePath(process.execPath)
  const target =
    marker && bundlePath ? getMacUpdateInstallMarkerPath(bundlePath, marker) : ownedMarkerPath
  if (!target) {
    return
  }
  try {
    unlinkSync(target)
  } catch {
    // Already gone, or never written.
  }
  if (target === ownedMarkerPath) {
    ownedMarkerPath = null
  }
}

/**
 * Settle the previous run's install attempt, at startup.
 *
 * This is the only place we can learn that an install silently failed. ShipIt writes its `-9`
 * "App Still Running" abort to its own log and tells the app nothing, and the process that
 * requested the install is gone by then — so a marker that survives into a run of the OLD
 * version is proof the swap never landed.
 */
export function reconcileMacUpdateInstallMarker(): void {
  if (process.platform !== 'darwin') {
    return
  }
  const bundlePath = resolveMacAppBundlePath(process.execPath)
  if (!bundlePath) {
    return
  }
  const marker = readNewestMarkerForThisBundle()
  if (!marker) {
    return
  }
  if (marker.bundlePath !== bundlePath) {
    // A marker stored under this bundle's key that names another bundle is stale or corrupt.
    // Compare-and-delete so a concurrently written replacement is not the thing we remove.
    clearMacUpdateInstallMarker(marker)
    return
  }
  const runningVersion = app.getVersion()
  const applied = runningVersion === marker.targetVersion
  recordUpdaterLifecycle(
    applied ? 'install_applied' : 'install_did_not_apply',
    {
      fromVersion: marker.fromVersion,
      targetVersion: marker.targetVersion,
      runningVersion,
      ageMs: Date.now() - marker.createdAtMs
    },
    applied
      ? undefined
      : {
          level: 'warn',
          message: `Update to ${marker.targetVersion} was committed but ${runningVersion} is running; the installer did not apply it`
        }
  )
  // RULE: expiry is the only thing that DELETES a marker. Reconcile only settles the attempt it
  // reported on, by renaming it, so its outcome is not logged twice. Deleting here on any
  // liveness signal was unsound: the writer exits while ShipIt installs BY DESIGN, so a dead
  // writer is the normal state of a LIVE install, and treating it as spent removed live markers.
  //
  // Only the reported attempt is settled. An unexpired older sibling can therefore report its own
  // outcome on a later startup — telemetry noise, bounded by expiry, and preferable to settling
  // attempts this pass never examined.
  settleMacUpdateInstallMarker(marker)
}

/**
 * Should this launch step aside so an in-flight update can finish?
 *
 * ShipIt refuses to swap the bundle while any instance of it runs, so merely *being* this
 * process is what cancels the update — there is no way to start and also not block. Exiting
 * immediately lets ShipIt complete and relaunch the updated app, so the user's click still
 * opens Orca, just on the new version.
 *
 * Every uncertain input returns false: failing to open the app someone asked for is worse than
 * a cancelled update.
 */
export function shouldExitForInFlightMacUpdateInstall(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return false
  }
  const bundlePath = resolveMacAppBundlePath(process.execPath)
  if (!bundlePath) {
    return false
  }
  const runningVersion = app.getVersion()
  // Why every active attempt and not just the newest: with two attempts in flight, the newest may
  // belong to an owner that died before the installer started. If ANY live attempt is replacing
  // the build we are running, this launch is the one that would cancel it.
  // Why require a differing target: `decideMacUpdateLaunch` reads "the target version is what is
  // running" as "the swap already landed" — that is what stops this gate blocking launches forever
  // after a successful install. A same-version attempt is indistinguishable from that state, so it
  // can never gate, and picking one would mask an attempt that can.
  //
  // Accepted limitation: a genuine same-version repair install is therefore ungated. Orca only
  // installs a strictly newer build (allowDowngrade is false), so it is unreachable through the
  // update path.
  const now = Date.now()
  const markers = readActiveMarkersForThisBundle()
  let shipItLiveness: 'live' | 'unverifiable' | 'exited' | undefined
  const processStarts = getProcessStartTimes(markers.map((marker) => marker.requestedByPid))
  const marker = selectInFlightMarker(markers, now, (candidate) => {
    if (candidate.fromVersion !== runningVersion || candidate.targetVersion === runningVersion) {
      return false
    }
    const writerAlive = isRecordedProcessAlive(
      candidate.requestedByPid,
      candidate.requestedByStartedAtMs,
      processStarts
    )
    return isAttemptInFlight({
      marker: candidate,
      now,
      shipItLiveness: writerAlive
        ? 'exited'
        : (shipItLiveness ??= getShipItLivenessForBundle(bundlePath)),
      writerAlive
    })
  })
  const decision = decideMacUpdateLaunch({
    marker,
    bundlePath,
    // Why the running version stands in for the bundle's: this process was launched from the
    // bundle, so it reports what was on disk at exec time without a synchronous plist read on
    // the startup path.
    bundleVersion: runningVersion,
    now
  })
  if (decision !== 'wait') {
    return false
  }
  // Only step aside for the exact build being replaced. Anything else is a different app and
  // blocking it would be a lockout, not a fix.
  if (marker?.fromVersion !== runningVersion) {
    return false
  }
  // RULE: one decision core for both gates. The writer pid answers the PHASE question — until it
  // exits, ShipIt cannot have spawned — which is what the wall-clock grace was standing in for.
  // Recheck after choosing a marker: a writer or installer can finish between the directory read
  // and this decision, and uncertain evidence must not make startup exit unnecessarily.
  const refreshedProcessStarts = getProcessStartTimes([marker.requestedByPid])
  const writerAlive = isRecordedProcessAlive(
    marker.requestedByPid,
    marker.requestedByStartedAtMs,
    refreshedProcessStarts
  )
  if (
    !isAttemptInFlight({
      marker,
      now: Date.now(),
      shipItLiveness: writerAlive ? 'exited' : getShipItLivenessForBundle(bundlePath),
      writerAlive
    })
  ) {
    return false
  }
  recordUpdaterLifecycle(
    'launch_deferred_for_install',
    { targetVersion: marker.targetVersion, runningVersion },
    {
      level: 'warn',
      message: `Exiting so the staged update to ${marker.targetVersion} can install; the installer relaunches Orca when it finishes`
    }
  )
  return true
}
