import { readFileSync, readdirSync, unlinkSync } from 'node:fs'
import {
  MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS,
  decideMacUpdateLaunch,
  getMacUpdateInstallMarkerPath,
  readMacUpdateInstallMarkers,
  resolveMacAppBundlePath,
  isAttemptInFlight,
  isMarkerExpired,
  selectInFlightMarker,
  type MacUpdateInstallMarker
} from '../../shared/mac-update-install-marker'
import {
  getProcessStartTimes,
  getShipItLivenessForBundle,
  isRecordedProcessAlive
} from '../../shared/shipit-liveness'

import {
  readMacBundleVersion,
  waitForMacBundleVersion,
  waitForMacBundleVersionChange
} from './mac-app-update-bundle'

/** Bounded above the longest observed ShipIt wait (9m37s) so we do not give up while the
 *  installer is still working, and below anything a caller would read as a hang. */
const MAC_INSTALL_GATE_WAIT_MS = 11 * 60_000

export type MacUpdateInstallGateOutcome =
  /** No install in flight, or it finished — the caller should launch as usual. */
  | { kind: 'proceed' }
  /** The swap landed. ShipIt relaunches the app itself, so the caller must not launch a second. */
  | { kind: 'installed'; version: string }
  /** The wait expired without the swap landing. The caller launches anyway: an installer that
   *  is still going after this long is almost certainly wedged, and refusing to open the app is
   *  a worse failure than a cancelled update. */
  | { kind: 'gave-up'; targetVersion: string }
  /** ORCA_OPEN_COMMAND is set with no parseable bundle, so the launch target cannot be gated. */
  | { kind: 'untargetable-override' }

function readActiveMarkers(bundlePath: string): MacUpdateInstallMarker[] {
  const now = Date.now()
  const markers = readMacUpdateInstallMarkers(bundlePath, {
    list: (dir) => readdirSync(dir),
    readFile: (path) => readFileSync(path, 'utf8')
  })
  // Why sweep here too: a CLI-only machine never runs the app's own prune, so an attempt file left
  // by a crash would linger forever. Expired markers already govern nothing, so removing them
  // changes no decision.
  for (const marker of markers) {
    if (isMarkerExpired(marker, now)) {
      clearMarker(bundlePath, marker)
    }
  }
  return markers.filter((marker) => !isMarkerExpired(marker, now))
}

function clearMarker(bundlePath: string, marker: MacUpdateInstallMarker): void {
  try {
    // By exact filename: every attempt owns its own file, so this can never delete a newer one.
    unlinkSync(getMacUpdateInstallMarkerPath(bundlePath, marker))
  } catch {
    // Already gone.
  }
}

/**
 * Keep `orca open` from becoming the running instance that cancels an in-flight update.
 *
 * Squirrel's ShipIt refuses to swap the bundle while any instance of it is running, and it
 * gives up silently — the user is simply left on the old version. Reopening Orca during that
 * window is the single most common way our own updates get cancelled, so wait for the swap
 * rather than racing it.
 *
 * Every uncertain input resolves toward launching: refusing to open the app is a worse failure
 * than a cancelled update.
 */
export async function awaitMacUpdateInstall(
  executable: string,
  waitMs = MAC_INSTALL_GATE_WAIT_MS
): Promise<MacUpdateInstallGateOutcome> {
  // Why resolve the override: launchOrcaApp honours ORCA_APP_EXECUTABLE, so gating on this
  // process's own bundle would check one app while launching another — and the one being launched
  // is what cancels the install.
  //
  // ORCA_OPEN_COMMAND is deliberately NOT resolved: it is an arbitrary shell command whose target
  // cannot be parsed. This process's own bundle is the best available signal, so the gate still
  // applies; the residual gap is narrow — it needs that override AND a CLI running from a
  // different bundle than the command opens, which is a dev/e2e shape, not a user one.
  const openCommand = process.env.ORCA_OPEN_COMMAND?.trim()
  const appExecutable = process.env.ORCA_APP_EXECUTABLE?.trim()
  // Why refuse rather than guess: launch.ts gives ORCA_OPEN_COMMAND precedence, and an arbitrary
  // shell command's target cannot be parsed — so gating on this process's bundle could clear a
  // launch that then opens a different one mid-install. A safety gate must not approve what it
  // cannot check.
  const launchTarget = appExecutable || executable
  const bundlePath = resolveMacAppBundlePath(launchTarget)
  if (!bundlePath) {
    return { kind: 'proceed' }
  }
  const markers = readActiveMarkers(bundlePath)
  const currentVersion = await readMacBundleVersion(bundlePath)
  const now = Date.now()
  let shipItLiveness: 'live' | 'unverifiable' | 'exited' | undefined
  const processStarts = getProcessStartTimes(markers.map((marker) => marker.requestedByPid))
  // Why inspect every attempt: a dead newer marker can otherwise mask an older writer that is
  // still in the pre-spawn window and must keep this launch out of the bundle.
  const marker = selectInFlightMarker(markers, now, (candidate) => {
    if (
      currentVersion !== null &&
      (candidate.fromVersion !== currentVersion || candidate.targetVersion === currentVersion)
    ) {
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
  // Why only when a marker exists: refusing whenever the override is set would break dev and e2e
  // runs that never touch an install. The refusal is for the case that actually matters — an
  // install is pending and we cannot tell which bundle the override would open.
  // Why regardless of ORCA_APP_EXECUTABLE: launch.ts checks ORCA_OPEN_COMMAND FIRST, so when both
  // are set the command wins and the executable we would have gated is not what gets launched.
  if (marker && openCommand) {
    return { kind: 'untargetable-override' }
  }
  const decision = decideMacUpdateLaunch({
    marker,
    bundlePath,
    bundleVersion: currentVersion,
    now
  })
  if (decision === 'open') {
    return { kind: 'proceed' }
  }
  if (decision === 'clear-and-open') {
    // Why not delete: the app's own reconcile is what reports this attempt's outcome
    // (install_applied / install_did_not_apply). Removing the record here would make that report
    // silently disappear. Expiry is the only deleter.
    return { kind: 'proceed' }
  }

  // Recheck after choosing a marker: a writer or installer can finish between the directory read
  // and this decision, and uncertain evidence must not make the CLI wait unnecessarily.
  const refreshedProcessStarts = getProcessStartTimes([marker!.requestedByPid])
  const writerAlive = isRecordedProcessAlive(
    marker!.requestedByPid,
    marker!.requestedByStartedAtMs,
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
    // Why leave the marker: deleting here loses the record of a failed install. After a silent
    // -9 the writer is dead and ShipIt has exited, so this branch is exactly the aborted-install
    // case — and unlinking it means the next app start cannot report install_did_not_apply.
    // Expiry reclaims the marker without touching ShipIt's shared state.
    return { kind: 'proceed' }
  }

  const targetVersion = marker!.targetVersion
  // Why wait on a CHANGE rather than on targetVersion: markers record what each attempt asked
  // for, and with several attempts in flight the newest one's target may be a version nobody is
  // installing — its owner could have died before the installer ever started. Waiting for the
  // bundle to stop being the build we are running is correct for whichever attempt is real.
  // Why the target branch exists at all: when the plist is readable, decideMacUpdateLaunch has
  // already returned clear-and-open for a same-version attempt, so this only runs when the plist
  // was UNREADABLE and the baseline fell back to the attempt's own fromVersion. A change-based
  // wait would then never fire, because a same-version reinstall does not change the plist.
  const baseline = currentVersion ?? marker!.fromVersion
  // A late CLI launch must not wait a fresh 11 minutes on a marker that is about to expire.
  const markerWaitRemainingMs = Math.max(
    0,
    MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS - Math.max(0, Date.now() - marker!.createdAtMs)
  )
  const boundedWaitMs = Math.min(waitMs, markerWaitRemainingMs)
  const installed =
    targetVersion === baseline
      ? await waitForMacBundleVersion(launchTarget, targetVersion, boundedWaitMs)
      : await waitForMacBundleVersionChange(launchTarget, baseline, boundedWaitMs)
  // Why not clear: a later launch no longer re-waits on a finished attempt — the shared core
  // returns not-in-flight once the writer and installer are both gone — so deleting here buys
  // nothing and would destroy the outcome the app's reconcile is about to report.
  return installed
    ? { kind: 'installed', version: targetVersion }
    : { kind: 'gave-up', targetVersion }
}
