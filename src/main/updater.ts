/* eslint-disable max-lines */
import { app, BrowserWindow, powerMonitor } from 'electron'
import { is } from '@electron-toolkit/utils'
import type {
  LinuxPackageInstallInstructions,
  LinuxPackageInstallRecovery,
  UpdateCheckOptions,
  UpdateSource,
  UpdateStatus
} from '../shared/types'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot,
  RemoteServerUpdateSupport
} from '../shared/remote-server-update'
import {
  isWindowsSignatureCheckUnavailableFailure,
  isWindowsSignatureMismatchFailure
} from '../shared/updater-windows-signature-check'
import { killAllPty } from './ipc/pty'
import { withUpdaterSpan } from './observability/instrumentation'
import { loadElectronAutoUpdater, type ElectronAutoUpdater } from './electron-updater-loader'
import { writeMainThreadDiagnosticMarker } from './diagnostics/main-thread-churn-probe'
import {
  beginMacUpdateDownload,
  deferMacQuitUntilInstallerReady,
  isMacInstallerReady,
  markMacQuitAndInstallInFlight,
  resetMacInstallState
} from './updater-mac-install'
import {
  armUpdateInstallExitWatchdog,
  disarmUpdateInstallExitWatchdog
} from './update-install-exit-watchdog'
import { registerAutoUpdaterHandlers } from './updater-events'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'
import { getLinuxRootPackageType } from './linux-update-package-type'
import {
  beginLinuxPackageInstallDiagnosticCapture,
  createUpdaterDiagnosticLogger,
  endLinuxPackageInstallDiagnosticCapture,
  getLinuxPackageInstallDiagnostic,
  parseLinuxPackageInstallExitCode,
  redactLinuxPackageInstallText,
  type LinuxPackageInstallDiagnostic
} from './linux-package-install-diagnostic'
import {
  clearTrackedLinuxPackageArtifact,
  getTrackedLinuxPackageArtifact,
  resolveLinuxPackageInstallInstructions,
  revalidateLinuxPackageForInstall,
  revealLinuxPackage,
  type LinuxPackageArtifact,
  type LinuxPackageRecoveryUnavailableReason
} from './linux-package-update-recovery'
import {
  compareVersions,
  isBenignCheckFailure,
  isMissingUpdateManifestFailure,
  isPrereleaseVersion,
  statusesEqual
} from './updater-fallback'
import {
  fetchNewerReleaseTagsWithReadiness,
  getReleaseDownloadUrl
} from './updater-prerelease-feed'
import { fetchNudge, shouldApplyNudge } from './updater-nudge'
import {
  failServeUpdateHandoff,
  getServeUpdateHandoffFailure,
  hasServeUpdateSupervisor,
  requestServeUpdateHandoff
} from './serve-update-handoff'
import type { LocalBuildFeed } from './local-builds/local-build-feed-server'
import { listReleaseBuilds, resolveTargetBuild } from './updater-release-builds'
import {
  hasDedicatedReleaseRepo,
  isChannelSupportedOnPlatform,
  RELEASE_CHANNEL_LABELS,
  type ReleaseBuild,
  type ReleaseChannel
} from '../shared/release-channel'

type CheckFailureSource = 'event' | 'promise' | 'fallback-promise'
type MissingManifestPrereleaseFallbackResult = { userInitiated: boolean }
type PrimaryEventSuppression = { failureKey: string; error: unknown }
type UpdateCheckVariant = 'default' | 'prerelease' | 'perf'
type ReleaseFeedPreflightFailure = 'manifest-unavailable' | 'release-not-ready'
// Why: expected preflight outcomes need typed context so UI routing never depends on matching error text.
class ReleaseFeedPreflightError extends Error {
  constructor(
    readonly reason: ReleaseFeedPreflightFailure,
    readonly releaseChannel: UpdateCheckVariant,
    message: string
  ) {
    super(message)
    this.name = 'ReleaseFeedPreflightError'
  }
}
type ReleaseFeedPreflightResult = 'ready' | 'not-available'
export type UpdateInstallMode =
  | 'interactive'
  | 'supervised-headless-serve'
  | 'unsupported-headless-serve'

const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const AUTO_UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000
// Why: a persistently-failing feed used to re-arm the retry at a fixed 1h cadence forever (issue #7576); backoff doubles per failure up to this cap, any completed check resets.
const MAX_AUTO_UPDATE_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000
const NUDGE_POLL_INTERVAL_MS = 30 * 60 * 1000
const NUDGE_ACTIVATION_COOLDOWN_MS = 5 * 60 * 1000
const QUIT_AND_INSTALL_DELAY_MS = 100
const PRE_QUIT_CLEANUP_TIMEOUT_MS = 2_500
const UPDATE_CHECK_SILENT_SETTLE_DELAY_MS = 1_000
const UPDATE_CHECK_STALL_TIMEOUT_MS = 45_000

let mainWindowRef: BrowserWindow | null = null
let currentStatus: UpdateStatus = { state: 'idle' }
let userInitiatedCheck = false
let onBeforeQuitCleanup: (() => void | Promise<void>) | null = null
let autoUpdaterInitialized = false
// Why: modifier-clicking "Check for Updates" targets prerelease manifests; the feed still pins a concrete tag so cancelled prereleases without manifests are skipped.
let includePrereleaseActive = false
let availableVersion: string | null = null
let availableReleaseUrl: string | null = null
let pendingCheckFailureKey: string | null = null
let pendingCheckFailurePromise: Promise<void> | null = null
let autoUpdateCheckTimer: ReturnType<typeof setTimeout> | null = null
let nudgeCheckTimer: ReturnType<typeof setTimeout> | null = null
let pendingQuitAndInstallTimer: ReturnType<typeof setTimeout> | null = null
let quitAndInstallInProgress = false
// Why: the pre-install digest re-proof streams the whole package, so a second install request can
// arrive while it runs — after the quit timer was cleared but before the handoff owns the process.
let linuxPackageRevalidationInFlight = false
let updateInstallMode: UpdateInstallMode = 'interactive'
let lastInstallDeferralVersion = { download: null as string | null, install: null as string | null }
// Why: once install has committed, late 'error' events must not clear quittingForUpdate — that would re-enable dock activate mid-installer.
let updateInstallCommitted = false
// Why: recovery must only run after the native quitAndInstall call; pre-native errors must not clear quittingForUpdate or look like install recovery.
let quitAndInstallNativeInvoked = false
// Why: a synchronous throw out of quitAndInstall ends diagnostic capture before the catch runs, so stash the redacted text for it.
let lastInstallAttemptDiagnostic: LinuxPackageInstallDiagnostic | null = null
let persistLastUpdateCheckAt: ((timestamp: number) => void) | null = null
let _getLastUpdateCheckAt: (() => number | null) | null = null
let backgroundCheckLaunchPending = false
// Why: a promoted background check can emit an error event before its promise catch runs; keep the promotion attached to that launch.
let backgroundCheckPromotedToUserInitiated = false
let updateCheckStallTimer: ReturnType<typeof setTimeout> | null = null
let updateCheckSilentSettleTimer: ReturnType<typeof setTimeout> | null = null
let updateCheckAttemptSequence = 0
let activeUpdateCheckAttemptId: number | null = null
let activeUpdateCheckLaunchAttemptId: number | null = null
let activeUpdateCheckEventAttemptId: number | null = null
let updateAvailableEventPendingAttemptId: number | null = null
let pendingUserInitiatedCheckAfterInFlight: UpdateCheckVariant | null = null
let activeUpdateNudgeId: string | null = null
let awaitingNudgeCheckOutcome = false
let nudgeCheckInFlight = false
let lastNudgeCheckAt = 0
let publishingWindowLastGoodCheck: { lastGoodTag: string } | null = null
let pendingPrereleaseFallback: {
  primaryTag: string
  fallbackTag: string
  // Why: primary promise cleanup can run after fallback starts; fallback events need this attempt-scoped state, not the mutable global.
  userInitiated: boolean
  suppressedPrimaryPromiseFailureKey: string | null
  suppressedPrimaryEventFailure: PrimaryEventSuppression | null
  suppressedFallbackPromiseFailureKey: string | null
  suppressedFallbackEventFailureKey: string | null
  fallbackResultHandled: boolean
  fallbackCheckingForUpdateSeen: boolean
  retryLaunched: boolean
} | null = null

let _getPendingUpdateNudgeId: (() => string | null) | null = null
let _getDismissedUpdateNudgeId: (() => string | null) | null = null
let _setPendingUpdateNudgeId: ((id: string | null) => void) | null = null
let _setDismissedUpdateNudgeId: ((id: string | null) => void) | null = null
// Why: guards against duplicate download() calls while an accepted request transitions status to 'downloading'.
let downloadInFlight = false
/** Guards the macOS `activate` handler from reopening the old version while ShipIt replaces the .app bundle. */
let quittingForUpdate = false
let autoUpdater: ElectronAutoUpdater | null = null
let activeUpdateSource: 'release' | UpdateSource = 'release'
let activeLocalBuildFeed: LocalBuildFeed | null = null
let localBuildSelectionInProgress = false
// Why: a dev channel/tag jump may target an older build, so it needs allowDowngrade
// like local builds — but off a real release feed, not a loopback server.
let pinnedBuildSelectionInProgress = false
// Why: a pinned jump to a stable/rc tag keeps the 'release' source but is still a
// deliberate downgrade, so newer-only gates must yield to it too.
let isPinnedBuildActive = false
let getReleaseChannelOverride: (() => ReleaseChannel | null) | null = null

function getAutoUpdater(): ElectronAutoUpdater {
  if (!autoUpdater) {
    autoUpdater = loadElectronAutoUpdater()
  }
  return autoUpdater
}

function clearAvailableUpdateContext(): void {
  availableVersion = null
  availableReleaseUrl = null
}

function closeLocalBuildFeed(): void {
  const feed = activeLocalBuildFeed
  activeLocalBuildFeed = null
  if (feed) {
    void feed.close()
  }
}

function restoreReleaseUpdateSource(): void {
  closeLocalBuildFeed()
  activeUpdateSource = 'release'
  isPinnedBuildActive = false
  if (autoUpdater) {
    autoUpdater.allowDowngrade = false
    autoUpdater.disableDifferentialDownload = false
    // Why: a pinned jump forces allowPrerelease on; leaving it set would opt
    // every later background check into the RC channel behind the user's back.
    autoUpdater.allowPrerelease = includePrereleaseActive
  }
}

function sendLocalBuildErrorAndRestore(message: string, userInitiated?: boolean): void {
  clearAvailableUpdateContext()
  if (
    currentStatus.state !== 'error' ||
    currentStatus.message !== message ||
    currentStatus.userInitiated !== userInitiated ||
    currentStatus.source !== 'local'
  ) {
    sendStatus({ state: 'error', message, userInitiated, source: 'local' })
  }
  restoreReleaseUpdateSource()
}

function clearPrereleaseFallbackContext(): void {
  pendingPrereleaseFallback = null
}

function clearPendingUpdateNudge(): void {
  activeUpdateNudgeId = null
  awaitingNudgeCheckOutcome = false
  _setPendingUpdateNudgeId?.(null)
}

function deferPendingUpdateNudgeUntilRetry(): void {
  activeUpdateNudgeId = null
  awaitingNudgeCheckOutcome = false
}

function clearPublishingWindowLastGoodCheck(): void {
  publishingWindowLastGoodCheck = null
}

function getPublishingWindowLastGoodCheck(): { lastGoodTag: string } | null {
  return publishingWindowLastGoodCheck
}

function getPersistedPendingUpdateNudgeId(): string | null {
  return _getPendingUpdateNudgeId?.() ?? null
}

function decorateStatusWithActiveNudge(status: UpdateStatus): UpdateStatus {
  // Why: only actionable/error states carry the nudge marker so the renderer knows a dismiss should ack the campaign; cycle-boundary states never need it.
  if (!activeUpdateNudgeId) {
    return status
  }
  if (status.state === 'idle' || status.state === 'checking' || status.state === 'not-available') {
    return status
  }
  return { ...status, activeNudgeId: activeUpdateNudgeId }
}

/** `force` re-delivers a status the renderer must not miss even when it repeats the current one. */
function sendStatus(status: UpdateStatus, options?: { force?: boolean }): void {
  const pendingUserInitiatedCheckVariant = pendingUserInitiatedCheckAfterInFlight
  const shouldLaunchPendingUserInitiatedCheck =
    pendingUserInitiatedCheckVariant !== null &&
    (status.state === 'idle' ||
      status.state === 'not-available' ||
      status.state === 'available' ||
      status.state === 'error')
  const shouldPreserveNudgeForPublishingWindow =
    publishingWindowLastGoodCheck !== null &&
    (status.state === 'idle' ||
      status.state === 'not-available' ||
      status.state === 'available' ||
      status.state === 'error')
  if (awaitingNudgeCheckOutcome) {
    if (status.state === 'available') {
      if (shouldPreserveNudgeForPublishingWindow) {
        // Why: a last-good available update is only a temporary fallback; dismissing it must not consume the newest-release nudge campaign.
        deferPendingUpdateNudgeUntilRetry()
      } else {
        awaitingNudgeCheckOutcome = false
      }
    } else if (
      status.state === 'idle' ||
      status.state === 'not-available' ||
      status.state === 'error'
    ) {
      if (shouldPreserveNudgeForPublishingWindow) {
        // Why: last-good checks can say "not available" while the campaign's newest release is still publishing.
        deferPendingUpdateNudgeUntilRetry()
      } else {
        // Why: on no-update, mark the campaign dismissed so a nudge covering already-up-to-date users doesn't re-fire every 30-min poll.
        if (activeUpdateNudgeId) {
          _setDismissedUpdateNudgeId?.(activeUpdateNudgeId)
        }
        clearPendingUpdateNudge()
      }
    }
  }

  const sourcedStatus: UpdateStatus =
    activeUpdateSource === 'release' ? status : { ...status, source: activeUpdateSource }
  const decoratedStatus = decorateStatusWithActiveNudge(sourcedStatus)

  if (isUpdateCheckResultState(status.state)) {
    finishActiveUpdateCheckAttempt()
  }

  if (
    status.state === 'idle' ||
    status.state === 'not-available' ||
    status.state === 'available' ||
    status.state === 'error'
  ) {
    clearPublishingWindowLastGoodCheck()
  }

  // Why: reset the in-flight guard once status moves past the window where duplicate download() calls are possible.
  if (
    decoratedStatus.state === 'downloading' ||
    decoratedStatus.state === 'error' ||
    decoratedStatus.state === 'idle'
  ) {
    downloadInFlight = false
  }
  if (shouldLaunchPendingUserInitiatedCheck) {
    // Why: a forced status must still land before the queued check restarts the cycle.
    if (options?.force) {
      currentStatus = decoratedStatus
      mainWindowRef?.webContents.send('updater:status', decoratedStatus)
    }
    launchPendingUserInitiatedCheckAfterInFlight(pendingUserInitiatedCheckVariant)
    return
  }
  if (!options?.force && statusesEqual(currentStatus, decoratedStatus)) {
    return
  }
  currentStatus = decoratedStatus
  mainWindowRef?.webContents.send('updater:status', decoratedStatus)
}

function getOptionsForUpdateCheckVariant(variant: UpdateCheckVariant): UpdateCheckOptions {
  switch (variant) {
    case 'perf':
      return { includePrerelease: true, includePerfPrerelease: true }
    case 'prerelease':
      return { includePrerelease: true }
    case 'default':
      return { includePrerelease: false }
  }
}

function getUpdateCheckVariant(options?: UpdateCheckOptions): UpdateCheckVariant {
  if (options?.includePerfPrerelease) {
    return 'perf'
  }
  if (options?.includePrerelease) {
    return 'prerelease'
  }
  // Why: a persisted 'rc' override makes every routine check follow the RC series
  // without the user re-holding shift; the dev channels need an explicit tag, so
  // neither is a routine-check variant.
  if (getReleaseChannelOverride?.() === 'rc') {
    return 'prerelease'
  }
  return 'default'
}

function launchPendingUserInitiatedCheckAfterInFlight(variant: UpdateCheckVariant): void {
  pendingUserInitiatedCheckAfterInFlight = null
  setTimeout(() => {
    // Why: defer one tick after electron-updater clears its in-flight promise so the queued modifier check starts fresh instead of deduping into the stable one.
    if (currentStatus.state === 'checking') {
      currentStatus = { state: 'idle' }
    }
    checkForUpdatesFromMenu(getOptionsForUpdateCheckVariant(variant))
  }, 0)
}

function clearBackgroundCheckLaunchPending(): void {
  backgroundCheckLaunchPending = false
}

function clearUpdateCheckStallTimer(): void {
  if (!updateCheckStallTimer) {
    return
  }
  clearTimeout(updateCheckStallTimer)
  updateCheckStallTimer = null
}

function clearUpdateCheckSilentSettleTimer(): void {
  if (!updateCheckSilentSettleTimer) {
    return
  }
  clearTimeout(updateCheckSilentSettleTimer)
  updateCheckSilentSettleTimer = null
}

function clearUpdateCheckTimers(): void {
  clearUpdateCheckStallTimer()
  clearUpdateCheckSilentSettleTimer()
}

function finishActiveUpdateCheckAttempt(): void {
  activeUpdateCheckAttemptId = null
  activeUpdateCheckLaunchAttemptId = null
  activeUpdateCheckEventAttemptId = null
  clearUpdateCheckTimers()
}

function getActiveUpdateCheckEventAttemptId(): number | null {
  if (activeUpdateCheckAttemptId === null) {
    return null
  }
  if (activeUpdateCheckEventAttemptId !== activeUpdateCheckAttemptId) {
    return null
  }
  return activeUpdateCheckAttemptId
}

function isActiveUpdateCheckAttempt(attemptId: number): boolean {
  return activeUpdateCheckAttemptId === attemptId
}

function markUpdateCheckEventAttempt(): boolean {
  if (activeUpdateCheckAttemptId === null) {
    return false
  }
  if (activeUpdateCheckLaunchAttemptId !== activeUpdateCheckAttemptId) {
    return false
  }
  activeUpdateCheckEventAttemptId = activeUpdateCheckAttemptId
  return true
}

function markUpdateCheckLaunched(attemptId: number): void {
  if (!isActiveUpdateCheckAttempt(attemptId)) {
    return
  }
  activeUpdateCheckLaunchAttemptId = attemptId
}

function markUpdateAvailableEventPending(attemptId: number | null): void {
  updateAvailableEventPendingAttemptId = attemptId
}

function clearUpdateAvailableEventPending(attemptId: number | null): void {
  if (updateAvailableEventPendingAttemptId !== attemptId) {
    return
  }
  updateAvailableEventPendingAttemptId = null
}

function armUpdateCheckStallTimer(attemptId: number): void {
  clearUpdateCheckStallTimer()
  updateCheckStallTimer = setTimeout(() => {
    updateCheckStallTimer = null
    if (!isActiveUpdateCheckAttempt(attemptId)) {
      return
    }
    const wasUserInitiated = getSettledCheckUserInitiated()
    if (currentStatus.state === 'checking') {
      finishActiveUpdateCheckAttempt()
      backgroundCheckLaunchPending = false
      backgroundCheckPromotedToUserInitiated = false
      userInitiatedCheck = false
      void sendCheckFailureStatus(
        'Update check timed out. Try again in a few minutes.',
        wasUserInitiated,
        'promise'
      )
      return
    }
    if (backgroundCheckLaunchPending) {
      finishActiveUpdateCheckAttempt()
      backgroundCheckLaunchPending = false
      backgroundCheckPromotedToUserInitiated = false
      userInitiatedCheck = false
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
    }
  }, UPDATE_CHECK_STALL_TIMEOUT_MS)
}

function beginUpdateCheckAttempt(): number {
  finishActiveUpdateCheckAttempt()
  updateAvailableEventPendingAttemptId = null
  updateCheckAttemptSequence += 1
  activeUpdateCheckAttemptId = updateCheckAttemptSequence
  armUpdateCheckStallTimer(activeUpdateCheckAttemptId)
  // Why: issue #7576 warnings recurred at retry cadence; timestamp each attempt to confirm or rule out the updater.
  writeMainThreadDiagnosticMarker('updater-check-attempt')
  return activeUpdateCheckAttemptId
}

function rearmActiveUpdateCheckStallTimer(): void {
  if (activeUpdateCheckAttemptId === null) {
    return
  }
  armUpdateCheckStallTimer(activeUpdateCheckAttemptId)
}

function getSettledCheckUserInitiated(): boolean | undefined {
  return userInitiatedCheck || backgroundCheckPromotedToUserInitiated || undefined
}

function isUpdateCheckResultState(state: UpdateStatus['state']): boolean {
  return (
    state === 'idle' ||
    state === 'not-available' ||
    state === 'available' ||
    state === 'error' ||
    state === 'downloading' ||
    state === 'downloaded'
  )
}

function consumeSilentCheckShortRetryReason(): boolean {
  if (publishingWindowLastGoodCheck !== null) {
    return true
  }
  return consumeMissingManifestPrereleaseFallbackResult() !== null
}

function completeSilentUpdateCheck(userInitiated: boolean | undefined): boolean {
  const shouldRetrySoon = consumeSilentCheckShortRetryReason()
  clearAvailableUpdateContext()
  if (shouldRetrySoon) {
    // Why: a silent result against a temporary last-good feed is still a release transition, so it must not suppress the short publish retry.
    scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
    return true
  }
  recordCompletedUpdateCheck()
  if (!userInitiated) {
    scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
  }
  return false
}

function settleSilentUpdateCheck(attemptId: number, userInitiated: boolean | undefined): void {
  if (!isActiveUpdateCheckAttempt(attemptId)) {
    return
  }
  if (updateAvailableEventPendingAttemptId === attemptId) {
    return
  }
  if (currentStatus.state !== 'checking') {
    if (backgroundCheckLaunchPending) {
      finishActiveUpdateCheckAttempt()
      clearBackgroundCheckLaunchPending()
      backgroundCheckPromotedToUserInitiated = false
      userInitiatedCheck = false
      const shouldRetrySoon = completeSilentUpdateCheck(userInitiated)
      if (awaitingNudgeCheckOutcome) {
        if (shouldRetrySoon) {
          deferPendingUpdateNudgeUntilRetry()
          return
        }
        sendStatus({ state: 'not-available', userInitiated })
      }
    }
    return
  }
  finishActiveUpdateCheckAttempt()
  clearBackgroundCheckLaunchPending()
  backgroundCheckPromotedToUserInitiated = false
  userInitiatedCheck = false
  completeSilentUpdateCheck(userInitiated)
  sendStatus({ state: 'not-available', userInitiated })
}

function handleSettledUpdateCheckPromise(attemptId: number): void {
  if (!isActiveUpdateCheckAttempt(attemptId)) {
    return
  }
  clearUpdateCheckSilentSettleTimer()
  // Why: electron-updater can resolve before the terminal event arrives; grace-period it, then unstick checks that resolved without one.
  updateCheckSilentSettleTimer = setTimeout(() => {
    updateCheckSilentSettleTimer = null
    settleSilentUpdateCheck(attemptId, getSettledCheckUserInitiated())
  }, UPDATE_CHECK_SILENT_SETTLE_DELAY_MS)
}

function shouldHandleUpdaterErrorEvent(): boolean {
  if (getActiveUpdateCheckEventAttemptId() !== null) {
    return true
  }
  // Why: electron-updater emits check errors globally; once a check settles, only active download/install flows should consume them.
  return (
    downloadInFlight ||
    currentStatus.state === 'downloading' ||
    currentStatus.state === 'downloaded'
  )
}

function sendErrorStatus(message: string, userInitiated?: boolean): void {
  if (
    currentStatus.state === 'error' &&
    currentStatus.message === message &&
    currentStatus.userInitiated === userInitiated
  ) {
    return
  }
  // Why: count AV/EDR-blocked Windows signature checks in the field to size the affected cohort before bigger updater changes.
  if (isWindowsSignatureCheckUnavailableFailure(message)) {
    recordUpdaterLifecycle('windows_signature_check_blocked', undefined, {
      level: 'warn',
      message: 'Windows update signature check could not run'
    })
  }
  sendStatus({ state: 'error', message, userInitiated })
}

function getKnownReleaseUrl(): string | undefined {
  return availableReleaseUrl ?? undefined
}

function hasInstallableDownloadedVersion(): boolean {
  return (
    availableVersion !== null &&
    // Why: local builds and pinned dev jumps may intentionally move backwards.
    (activeUpdateSource !== 'release' ||
      isPinnedBuildActive ||
      compareVersions(availableVersion, app.getVersion()) > 0)
  )
}

function getPendingInstallVersion(): string {
  if (availableVersion) {
    return availableVersion
  }
  if (currentStatus.state === 'downloading' || currentStatus.state === 'downloaded') {
    return currentStatus.version
  }
  return ''
}

function deferHeadlessServeInstall(phase: 'download' | 'install', version: string): boolean {
  if (updateInstallMode !== 'unsupported-headless-serve') {
    return false
  }
  const diagnosticVersion = version || 'unknown'
  if (lastInstallDeferralVersion[phase] !== diagnosticVersion) {
    lastInstallDeferralVersion[phase] = diagnosticVersion
    recordUpdaterLifecycle(
      'headless_serve_install_deferred',
      { phase, version: version || null },
      {
        level: 'warn',
        message: 'Update install deferred while hosting orca serve'
      }
    )
  }
  sendErrorStatus(
    'This orca serve process was not started by an update-capable supervisor. Keep it running and update Orca through its service manager.',
    true
  )
  return true
}

export function resolveUpdateInstallMode(isServeMode: boolean): UpdateInstallMode {
  if (!isServeMode) {
    return 'interactive'
  }
  return hasServeUpdateSupervisor() ? 'supervised-headless-serve' : 'unsupported-headless-serve'
}

function getCheckFailureKey(message: string, userInitiated?: boolean): string {
  return `${userInitiated ? 'user' : 'auto'}:${message}`
}

function clearPrereleaseFallbackContextIfSettled(): void {
  if (
    pendingPrereleaseFallback?.fallbackResultHandled &&
    !pendingPrereleaseFallback.suppressedPrimaryPromiseFailureKey &&
    !pendingPrereleaseFallback.suppressedPrimaryEventFailure &&
    !pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey &&
    !pendingPrereleaseFallback.suppressedFallbackEventFailureKey
  ) {
    clearPrereleaseFallbackContext()
  }
}

async function performQuitAndInstall(): Promise<void> {
  if (quitAndInstallInProgress || linuxPackageRevalidationInFlight) {
    recordUpdaterLifecycle('quit_and_install_ignored', { reason: 'already-in-progress' })
    return
  }

  if (pendingQuitAndInstallTimer) {
    clearTimeout(pendingQuitAndInstallTimer)
    pendingQuitAndInstallTimer = null
  }

  const pendingVersion = getPendingInstallVersion()
  if (deferHeadlessServeInstall('install', pendingVersion)) {
    return
  }
  // Why: the retained .deb/.rpm sits on a user-writable path that a root package manager is about
  // to read, and nothing re-checks it after download. Re-prove it here — before any teardown — so a
  // swapped or vanished package aborts instead of being installed as root. The synchronous guard
  // keeps every non-Linux install on its existing timing.
  if (getTrackedLinuxPackageArtifact() && !(await proveRetainedLinuxPackage(pendingVersion))) {
    // Why: the renderer armed its restart before invoking, and it infers the abort from the error
    // status — which a stale-cycle verdict deliberately withholds. Signal the abandon here, where
    // it cannot depend on that decision, or the window keeps skipping its unsaved-work prompt.
    mainWindowRef?.webContents.send('updater:quitAndInstallAborted')
    return
  }
  quitAndInstallInProgress = true

  markMacQuitAndInstallInFlight()

  // Set BEFORE anything else so the `activate` handler doesn't reopen the old version while ShipIt replaces the .app bundle.
  quittingForUpdate = true

  try {
    await withUpdaterSpan({ stage: 'install' }, async (span) => {
      span.setAttribute('updater.version', pendingVersion || 'unknown')
      span.setAttribute('updater.platform', process.platform)
      span.setAttribute(
        'updater.macosInstallerReady',
        process.platform === 'darwin' ? isMacInstallerReady() : true
      )
      recordUpdaterLifecycle('quit_and_install_started', {
        version: pendingVersion || null,
        macInstallerReady: process.platform === 'darwin' ? isMacInstallerReady() : true
      })
      span.addEvent('pre_quit_cleanup_start')
      await runBeforeUpdateQuitCleanup()
      span.addEvent('pre_quit_cleanup_done')

      if (
        updateInstallMode === 'supervised-headless-serve' &&
        !requestServeUpdateHandoff(pendingVersion)
      ) {
        recordUpdaterLifecycle(
          'headless_serve_handoff_failed',
          { version: pendingVersion || null },
          {
            level: 'warn',
            message: 'Could not persist supervised serve update handoff'
          }
        )
        sendErrorStatus(
          'Could not prepare the supervised server restart. Orca remains running.',
          true
        )
        resetQuitForUpdateState()
        // Why: a bare return would exit this span Success and hide the aborted install from tracing.
        span.fail('Could not persist the supervised serve update handoff')
        return
      }

      recordUpdaterLifecycle('quit_and_install_invoking_native', {
        version: pendingVersion || null
      })
      // Why: defensive — never call quitAndInstall if recovery/reset already cleared the handoff.
      if (!quitAndInstallInProgress) {
        return
      }
      // Why: mark before the call so a sync 'error' during quitAndInstall can recover; pre-native errors must not look like install failure.
      quitAndInstallNativeInvoked = true
      // Why: invoke before killAllPty/removing close listeners so a sync 'error' (the "no filepath" path) can recover while windows and PTYs are intact.
      const supervisorOwnsRelaunch = updateInstallMode === 'supervised-headless-serve'
      // Why: BaseUpdater logs child stderr but drops it from the 'error' event, so retain it for the span of this call.
      beginLinuxPackageInstallDiagnosticCapture(getTrackedLinuxPackageArtifact()?.path ?? null)
      try {
        getAutoUpdater().quitAndInstall(supervisorOwnsRelaunch, !supervisorOwnsRelaunch)
      } finally {
        const diagnostic = endLinuxPackageInstallDiagnosticCapture()
        // Why: a synchronous 'error' already consumed and reset this attempt; re-stashing would leak it into the next one.
        lastInstallAttemptDiagnostic = quitAndInstallInProgress ? diagnostic : null
      }
      span.addEvent('native_quit_and_install_invoked')

      // Why: quitAndInstall can synchronously clear quitAndInstallInProgress via recovery (Win/Linux dispatchError); skip destructive prep if it already ran.
      if (!quitAndInstallInProgress) {
        // Why: recovery already wrote the reason to currentStatus; a bare return would exit this span Success.
        span.fail(
          currentStatus.state === 'error'
            ? currentStatus.message
            : 'quitAndInstall returned without invoking the installer'
        )
        return
      }

      // Why: DebUpdater/RpmUpdater install through spawnSync, so a normal return already means the
      // package is installed. Commit here or a throw in the cleanup below is reported as an install
      // failure — offering a recovery card, and stale stderr, for an update that actually succeeded.
      if (getLinuxRootPackageType() !== null) {
        updateInstallCommitted = true
        armUpdateInstallExitWatchdog()
      }

      killAllPty()
      span.addEvent('local_pty_kill_all')

      for (const win of BrowserWindow.getAllWindows()) {
        win.removeAllListeners('close')
      }
      span.addEvent('window_close_listeners_removed', {
        windowCount: BrowserWindow.getAllWindows().length
      })

      // Why: committed installs keep quittingForUpdate so dock activate can't reopen the old process; macOS without Squirrel stays uncommitted so late native errors can still recover.
      if (!updateInstallCommitted && (process.platform !== 'darwin' || isMacInstallerReady())) {
        updateInstallCommitted = true
        // Why: past commit the installer waits for this process to exit; a wedged async shutdown would strand the user with no app and no update (#4438).
        armUpdateInstallExitWatchdog()
      }
    })
  } catch (error) {
    // Why: on Linux the package is already installed once quitAndInstall returns, and the installer is
    // waiting for this process to exit. Tearing down here would disarm the exit watchdog (#4438), clear
    // quittingForUpdate mid-quit, and tell the user an install failed that actually succeeded.
    if (updateInstallCommitted) {
      recordUpdaterLifecycle(
        'post_commit_cleanup_failed',
        { errorType: error instanceof Error ? error.name : typeof error },
        {
          level: 'warn',
          message: 'Update install cleanup failed after commit; install already applied'
        }
      )
      return
    }
    // Why: a pre-native cleanup/tracing exception is not a package install failure and must not be labelled as one.
    const quitAndInstallNativeInvokedBeforeReset = quitAndInstallNativeInvoked
    const recoveryStatus =
      quitAndInstallNativeInvokedBeforeReset && !updateInstallCommitted
        ? buildLinuxPackageInstallFailureStatus(error)
        : null
    failServeUpdateHandoff('Could not invoke the native updater.')
    resetQuitForUpdateState()
    recordUpdaterLifecycle(
      'quit_and_install_failed',
      { errorType: error instanceof Error ? error.name : typeof error },
      {
        level: 'warn',
        message: 'Could not start update install'
      }
    )
    sendInstallFailureStatus(
      recoveryStatus ?? {
        state: 'error',
        // Why: past the native invoke this is the same pre-commit failure the event path reports, so it gets the same copy; only a pre-native exception can be helped by a restart.
        // A synchronous throw out of quitAndInstall carries the same installer text the 'error' event would have.
        message: quitAndInstallNativeInvokedBeforeReset
          ? withInstallFailureCause(getPreCommitInstallFailureMessage(), error)
          : 'Could not restart to install the update. Quit and reopen Orca, then try again.'
      }
    )
  }
}

function resetQuitForUpdateState(): void {
  quitAndInstallInProgress = false
  quittingForUpdate = false
  updateInstallCommitted = false
  quitAndInstallNativeInvoked = false
  lastInstallAttemptDiagnostic = null
  disarmUpdateInstallExitWatchdog()
  resetMacInstallState()
}

/**
 * On macOS a pre-commit failure means Squirrel rejected the staged update, and quitting does re-stage
 * it — so keep that advice there. Everywhere else a restart is not known to help.
 */
function getPreCommitInstallFailureMessage(): string {
  return process.platform === 'darwin'
    ? 'Could not restart to install the update. Quit and reopen Orca, then try again.'
    : 'Could not start the update installer. Orca remains open.'
}

/**
 * Sends an install-failure status even when it repeats the current one. "Try Automatic Install
 * Again" usually fails identically, and a deduped status would never reach the preload abort relay,
 * leaving the renderer stuck in its restart checkpoint.
 */
function sendInstallFailureStatus(status: UpdateStatus): void {
  sendStatus(status, { force: true })
}

const INSTALL_FAILURE_CAUSE_MAX_LENGTH = 200

/**
 * Appends the updater's own text to the generic install-failure copy. Without it the only record of
 * why the install never started is destroyed — on Linux that text carries the exact `dpkg -i <path>`
 * command the user has to run by hand, and remote clients get nothing but "it didn't come back".
 */
function withInstallFailureCause(baseMessage: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  // Why: the retained-package card runs its text through this same sanitizer, so a home directory,
  // user name, or terminal escape must not reach the card merely because no artifact was tracked.
  const redacted =
    redactLinuxPackageInstallText(raw, getTrackedLinuxPackageArtifact()?.path ?? null) ?? ''
  const cause = redacted.slice(0, INSTALL_FAILURE_CAUSE_MAX_LENGTH)
  if (!cause || cause === 'Unknown error') {
    return baseMessage
  }
  // Why: UpdateCard picks the whole card off this string, so a signature verdict must not be prefixed by contradictory restart advice.
  if (
    isWindowsSignatureCheckUnavailableFailure(cause) ||
    isWindowsSignatureMismatchFailure(cause)
  ) {
    return cause
  }
  return `${baseMessage} (${cause})`
}

/**
 * The recovery status for a failed `.deb`/`.rpm` install, or null when no retained package can
 * recover it. Must run before `resetQuitForUpdateState()` clears the attempt diagnostic.
 */
function buildLinuxPackageInstallFailureStatus(error: unknown): UpdateStatus | null {
  const artifact = getTrackedLinuxPackageArtifact()
  if (!artifact) {
    return null
  }
  const pendingVersion = getPendingInstallVersion()
  if (pendingVersion && pendingVersion !== artifact.version) {
    return null
  }
  const diagnostic = getLinuxPackageInstallDiagnostic() ?? lastInstallAttemptDiagnostic
  // Why: the reason was classified from the original output, before redaction could rewrite a match.
  const reason = diagnostic?.reason ?? 'package-install-failed'
  // Durable data carries classification only — never the package path, home path, command, or stderr.
  const exitCode = parseLinuxPackageInstallExitCode(error)
  recordUpdaterLifecycle(
    'linux_package_install_failed',
    {
      packageType: artifact.packageType,
      reason,
      // Omitted rather than null when the child status could not be parsed.
      ...(exitCode === null ? {} : { exitCode }),
      version: artifact.version,
      errorType: error instanceof Error ? error.name : typeof error
    },
    { level: 'warn', message: 'Linux package install failed; cached package retained' }
  )
  // Why: this text is shown in the card, so it gets the same redaction as retained stderr.
  const message =
    diagnostic?.message ??
    (error instanceof Error ? redactLinuxPackageInstallText(error.message, artifact.path) : null) ??
    'The system package installer did not start.'
  return {
    state: 'error',
    message,
    recovery: {
      kind: 'linux-package-install',
      packageType: artifact.packageType,
      reason,
      version: artifact.version
    }
  }
}

// Why: quitAndInstall failures arrive via 'error'; recover only after native invoke and before commit, else clearing quittingForUpdate lets dock activate reopen the old process mid-installer.
function handleQuitAndInstallFailure(error?: unknown): boolean {
  if (!quitAndInstallInProgress || !quitAndInstallNativeInvoked || updateInstallCommitted) {
    return false
  }
  const recoveryStatus = buildLinuxPackageInstallFailureStatus(error)
  failServeUpdateHandoff('The native updater rejected the install request.')
  resetQuitForUpdateState()
  // Durable data carries classification only — the cause text stays on the status the user can read.
  recordUpdaterLifecycle(
    'quit_and_install_failed_via_event',
    { errorType: error instanceof Error ? error.name : typeof error },
    {
      level: 'warn',
      message: 'Update install could not start; recovered app state'
    }
  )
  sendInstallFailureStatus(
    recoveryStatus ?? {
      state: 'error',
      message: withInstallFailureCause(getPreCommitInstallFailureMessage(), error)
    }
  )
  return true
}

// Why: while quit-and-install owns the process, general check/download error UI must not run.
function isQuitAndInstallHandoffActive(): boolean {
  return quitAndInstallInProgress
}

async function runBeforeUpdateQuitCleanup(): Promise<void> {
  if (!onBeforeQuitCleanup) {
    return
  }

  let timeout: ReturnType<typeof setTimeout> | null = null
  const cleanup = Promise.resolve()
    .then(() => onBeforeQuitCleanup?.())
    .catch((error) => {
      recordUpdaterLifecycle(
        'pre_quit_cleanup_failed',
        { errorType: error instanceof Error ? error.name : typeof error },
        {
          level: 'warn',
          message: 'Pre-quit cleanup failed; continuing update install'
        }
      )
    })
  const timeoutResult = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), PRE_QUIT_CLEANUP_TIMEOUT_MS)
  })

  const result = await Promise.race([cleanup.then(() => 'done' as const), timeoutResult])
  if (result === 'timeout') {
    recordUpdaterLifecycle(
      'pre_quit_cleanup_timeout',
      { timeoutMs: PRE_QUIT_CLEANUP_TIMEOUT_MS },
      {
        level: 'warn',
        message: `Pre-quit cleanup exceeded ${PRE_QUIT_CLEANUP_TIMEOUT_MS}ms; continuing update install`
      }
    )
    return
  }

  if (timeout) {
    clearTimeout(timeout)
  }
}

async function sendCheckFailureStatus(
  message: string,
  userInitiated?: boolean,
  source: CheckFailureSource = 'promise',
  sourceError?: unknown
): Promise<void> {
  if (activeUpdateSource === 'local') {
    sendLocalBuildErrorAndRestore(message, userInitiated)
    return
  }
  if (isPinnedBuildActive) {
    // Why: a failed pinned jump must hand the feed back before surfacing the
    // error, or the pin blocks background checks for the process lifetime.
    clearAvailableUpdateContext()
    restoreReleaseUpdateSource()
    sendStatus({ state: 'error', message, userInitiated })
    return
  }
  const failureKey = getCheckFailureKey(message, userInitiated)
  if (
    source === 'promise' &&
    pendingPrereleaseFallback?.suppressedPrimaryPromiseFailureKey === failureKey
  ) {
    pendingPrereleaseFallback.suppressedPrimaryPromiseFailureKey = null
    clearPrereleaseFallbackContextIfSettled()
    return
  }
  if (
    source === 'fallback-promise' &&
    pendingPrereleaseFallback?.suppressedFallbackPromiseFailureKey === failureKey
  ) {
    pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey = null
    clearPrereleaseFallbackContextIfSettled()
    return
  }

  if (
    retryPrereleaseFallbackAfterMissingManifest(
      message,
      userInitiated,
      source,
      failureKey,
      sourceError
    )
  ) {
    return
  }

  if (pendingCheckFailureKey === failureKey && pendingCheckFailurePromise) {
    return pendingCheckFailurePromise
  }

  const handleFailure = async (): Promise<void> => {
    if (isBenignCheckFailure(message) || isRetryableReleaseFeedPreflightFailure(sourceError)) {
      // Why: benign failures (incomplete latest.yml, network blips) are transient — retry, and skip persisting the timestamp (would suppress the next startup check).
      console.warn('[updater] benign check failure:', message)
      clearAvailableUpdateContext()
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      if (userInitiated) {
        // Why: a user click needs visible feedback (idle looks broken); distinguish incomplete releases from transport failures.
        sendErrorStatus(
          isStableReleaseNotReadyFailure(sourceError)
            ? "A newer release isn't available for this device yet. Check again later."
            : "Couldn't reach the update server. Try again in a few minutes.",
          true
        )
      } else {
        if (isRetryableReleaseFeedPreflightFailure(sourceError)) {
          // Why: release probes can fail transiently; keep the campaign pending so the short retry can still show it.
          deferPendingUpdateNudgeUntilRetry()
        }
        sendStatus({ state: 'idle' })
      }
      return
    }

    clearAvailableUpdateContext()
    persistLastUpdateCheckAt?.(Date.now())
    if (!userInitiated) {
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
    }
    sendErrorStatus(message, userInitiated)
  }

  pendingCheckFailureKey = failureKey
  pendingCheckFailurePromise = handleFailure().finally(() => {
    if (pendingCheckFailureKey === failureKey) {
      pendingCheckFailureKey = null
      pendingCheckFailurePromise = null
    }
  })
  return pendingCheckFailurePromise
}

function isRetryableReleaseFeedPreflightFailure(sourceError: unknown): boolean {
  return (
    sourceError instanceof ReleaseFeedPreflightError &&
    (sourceError.reason === 'release-not-ready' || sourceError.reason === 'manifest-unavailable')
  )
}

function isStableReleaseNotReadyFailure(sourceError: unknown): boolean {
  return (
    sourceError instanceof ReleaseFeedPreflightError &&
    sourceError.reason === 'release-not-ready' &&
    sourceError.releaseChannel === 'default'
  )
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

export function getRemoteServerUpdateSupport(): RemoteServerUpdateSupport {
  if (!app.isPackaged || is.dev) {
    return {
      installMode: updateInstallMode,
      automatic: false,
      reason: 'unpackaged-build'
    }
  }
  if (!autoUpdaterInitialized) {
    return {
      installMode: updateInstallMode,
      automatic: false,
      reason: 'updater-unavailable'
    }
  }
  if (updateInstallMode === 'unsupported-headless-serve') {
    return {
      installMode: updateInstallMode,
      automatic: false,
      reason: 'manual-service-update-required'
    }
  }
  return { installMode: updateInstallMode, automatic: true, reason: 'available' }
}

export function getRemoteServerUpdaterSnapshot(runtimeId: string): RemoteServerUpdaterSnapshot {
  return {
    appVersion: app.getVersion(),
    runtimeId,
    support: getRemoteServerUpdateSupport(),
    status: getUpdateStatus()
  }
}

function assertRemoteServerUpdateAvailable(): void {
  if (!getRemoteServerUpdateSupport().automatic) {
    throw new Error('remote_update_manual_required')
  }
}

export function checkForRemoteServerUpdate(
  runtimeId: string,
  options?: UpdateCheckOptions
): RemoteServerUpdaterSnapshot {
  assertRemoteServerUpdateAvailable()
  checkForUpdatesFromMenu(options)
  return getRemoteServerUpdaterSnapshot(runtimeId)
}

export function downloadRemoteServerUpdate(runtimeId: string): RemoteServerUpdaterSnapshot {
  assertRemoteServerUpdateAvailable()
  if (currentStatus.state !== 'available') {
    throw new Error('remote_update_not_available')
  }
  downloadUpdate()
  return getRemoteServerUpdaterSnapshot(runtimeId)
}

export function installRemoteServerUpdate(runtimeId: string): RemoteServerUpdateInstallResult {
  assertRemoteServerUpdateAvailable()
  if (currentStatus.state !== 'downloaded') {
    throw new Error('remote_update_not_downloaded')
  }
  const targetVersion = currentStatus.version
  const result: RemoteServerUpdateInstallResult = {
    accepted: true,
    fromVersion: app.getVersion(),
    targetVersion,
    runtimeId
  }
  quitAndInstall()
  return result
}

let consecutiveAutomaticRetrySchedules = 0

function scheduleAutomaticUpdateCheck(delayMs: number): void {
  let effectiveDelayMs = delayMs
  // All retry-cadence callers pass exactly this constant, so keying backoff on it keeps one choke point instead of threading a flag through every schedule site.
  if (delayMs === AUTO_UPDATE_RETRY_INTERVAL_MS) {
    effectiveDelayMs = Math.min(
      AUTO_UPDATE_RETRY_INTERVAL_MS * 2 ** consecutiveAutomaticRetrySchedules,
      MAX_AUTO_UPDATE_RETRY_INTERVAL_MS
    )
    consecutiveAutomaticRetrySchedules += 1
  }
  if (autoUpdateCheckTimer) {
    clearTimeout(autoUpdateCheckTimer)
  }
  autoUpdateCheckTimer = setTimeout(() => {
    // Why: Orca runs for days, so keep the next background check scheduled in the main process rather than tying it to relaunches or renderer lifetime.
    if (!runBackgroundUpdateCheck()) {
      // Why: a deferred check reaches no outcome handler, so re-arm here or one deferral ends automatic checks for the process lifetime.
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
    }
  }, effectiveDelayMs)
}

function recordCompletedUpdateCheck(): void {
  consecutiveAutomaticRetrySchedules = 0
  persistLastUpdateCheckAt?.(Date.now())
}

function getMissingManifestPrereleaseFallbackUserInitiated(): boolean | null {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return null
  }
  return pendingPrereleaseFallback.userInitiated
}

function markMissingManifestPrereleaseFallbackChecking(): void {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return
  }
  pendingPrereleaseFallback.fallbackCheckingForUpdateSeen = true
}

function consumeMissingManifestPrereleaseFallbackResult(): MissingManifestPrereleaseFallbackResult | null {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return null
  }
  const result = { userInitiated: pendingPrereleaseFallback.userInitiated }
  pendingPrereleaseFallback.fallbackResultHandled = true
  clearPrereleaseFallbackContextIfSettled()
  return result
}

function suppressMissingManifestPrereleaseFallbackPromiseFailure(message: string): void {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return
  }
  pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey = getCheckFailureKey(
    message,
    pendingPrereleaseFallback.userInitiated
  )
}

function shouldSuppressMissingManifestPrereleaseFallbackEvent(
  message: string,
  error: unknown
): boolean {
  if (!pendingPrereleaseFallback?.retryLaunched) {
    return false
  }
  const failureKey = getCheckFailureKey(message, pendingPrereleaseFallback.userInitiated)
  const primaryEventSuppression = pendingPrereleaseFallback.suppressedPrimaryEventFailure
  if (primaryEventSuppression?.failureKey === failureKey) {
    const isPrimaryPromisePair = primaryEventSuppression.error === error
    // Why: after fallback checking starts, same-message errors may be the fallback's, so message matching alone isn't safe.
    if (isPrimaryPromisePair || !pendingPrereleaseFallback.fallbackCheckingForUpdateSeen) {
      pendingPrereleaseFallback.suppressedPrimaryEventFailure = null
      clearPrereleaseFallbackContextIfSettled()
      return true
    }
  }
  if (pendingPrereleaseFallback.suppressedFallbackEventFailureKey === failureKey) {
    pendingPrereleaseFallback.suppressedFallbackEventFailureKey = null
    clearPrereleaseFallbackContextIfSettled()
    return true
  }
  return false
}

function markMissingManifestPrereleaseFallbackPromiseHandled(message: string): void {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return
  }
  pendingPrereleaseFallback.suppressedFallbackEventFailureKey = getCheckFailureKey(
    message,
    pendingPrereleaseFallback.userInitiated
  )
}

async function pinDefaultReleaseFeed(
  variant: UpdateCheckVariant = 'default'
): Promise<ReleaseFeedPreflightResult> {
  const autoUpdater = getAutoUpdater()
  // Why: the latest/download redirect can move between check and download, so pin the concrete tag (prerelease users resolve any channel, stable only stable).
  const currentVersion = app.getVersion()
  const isPerfCheck = variant === 'perf'
  const includePrerelease =
    isPerfCheck || includePrereleaseActive || isPrereleaseVersion(currentVersion)
  const releaseTagsResult = await fetchNewerReleaseTagsWithReadiness(
    currentVersion,
    includePrerelease ? 2 : 1,
    {
      includePrerelease,
      ...(isPerfCheck ? { releaseFilter: 'perf' as const } : {})
    }
  )
  const newerTag = releaseTagsResult.tags[0] ?? null
  const fallbackTag = includePrerelease ? (releaseTagsResult.tags[1] ?? null) : null
  pendingPrereleaseFallback =
    includePrerelease && newerTag && fallbackTag
      ? {
          primaryTag: newerTag,
          fallbackTag,
          userInitiated: false,
          suppressedPrimaryPromiseFailureKey: null,
          suppressedPrimaryEventFailure: null,
          suppressedFallbackPromiseFailureKey: null,
          suppressedFallbackEventFailureKey: null,
          fallbackResultHandled: false,
          fallbackCheckingForUpdateSeen: false,
          retryLaunched: false
        }
      : null
  // Why: console.info is captured by Console.app/--enable-logging — our only field visibility into the updater.
  if (newerTag) {
    clearPublishingWindowLastGoodCheck()
    const url = getReleaseDownloadUrl(newerTag)
    console.info(
      `[updater] release feed pinned: current=${currentVersion} includePrerelease=${includePrerelease} → ${url}`
    )
    autoUpdater.setFeedURL({ provider: 'generic', url })
    return 'ready'
  } else if (releaseTagsResult.state === 'not-ready') {
    clearPrereleaseFallbackContext()
    if (releaseTagsResult.lastGoodTag) {
      // Why: during a publish window the newest tag is unsafe; a verified last-good concrete feed lets electron-updater emit a real result.
      const url = getReleaseDownloadUrl(releaseTagsResult.lastGoodTag)
      console.info(
        `[updater] release feed pinned to last-good: current=${currentVersion} includePrerelease=${includePrerelease} → ${url}`
      )
      publishingWindowLastGoodCheck = { lastGoodTag: releaseTagsResult.lastGoodTag }
      autoUpdater.setFeedURL({ provider: 'generic', url })
      return 'ready'
    }
    clearPublishingWindowLastGoodCheck()
    console.info(
      `[updater] release feed deferred: current=${currentVersion} includePrerelease=${includePrerelease}; newest release assets are not ready`
    )
    throw new ReleaseFeedPreflightError(
      'release-not-ready',
      isPerfCheck ? 'perf' : includePrerelease ? 'prerelease' : 'default',
      'Latest release artifacts are not ready'
    )
  } else if (
    releaseTagsResult.state === 'unavailable' &&
    releaseTagsResult.unavailableReason === 'manifest' &&
    !includePrerelease
  ) {
    clearPrereleaseFallbackContext()
    clearPublishingWindowLastGoodCheck()
    throw new ReleaseFeedPreflightError(
      'manifest-unavailable',
      'default',
      'Unable to find latest version on GitHub'
    )
  } else if (isPerfCheck) {
    clearPrereleaseFallbackContext()
    clearPublishingWindowLastGoodCheck()
    if (releaseTagsResult.state === 'no-newer') {
      console.info(
        `[updater] perf release not found: current=${currentVersion} includePrerelease=${includePrerelease}`
      )
      return 'not-available'
    }
    throw new Error('Could not resolve perf update feed')
  } else {
    clearPrereleaseFallbackContext()
    clearPublishingWindowLastGoodCheck()
    const url = 'https://github.com/stablyai/orca/releases/latest/download'
    console.info(
      `[updater] release feed fallback: current=${currentVersion} includePrerelease=${includePrerelease} → ${url}`
    )
    autoUpdater.setFeedURL({ provider: 'generic', url })
    return 'ready'
  }
}

function retryPrereleaseFallbackAfterMissingManifest(
  message: string,
  userInitiated: boolean | undefined,
  source: CheckFailureSource,
  failureKey: string,
  sourceError?: unknown
): boolean {
  if (
    !pendingPrereleaseFallback ||
    pendingPrereleaseFallback.retryLaunched ||
    !isMissingUpdateManifestFailure(message)
  ) {
    return false
  }
  const attemptId = activeUpdateCheckAttemptId
  if (attemptId === null) {
    return false
  }

  // Why: a published tag can briefly lack its platform manifest mid-release; walk back once to the previous feed for a normal not-available result.
  pendingPrereleaseFallback.retryLaunched = true
  pendingPrereleaseFallback.userInitiated = Boolean(userInitiated)
  pendingPrereleaseFallback.suppressedPrimaryPromiseFailureKey =
    source === 'event' ? failureKey : null
  pendingPrereleaseFallback.suppressedPrimaryEventFailure =
    source === 'promise' ? { failureKey, error: sourceError } : null
  pendingPrereleaseFallback.fallbackCheckingForUpdateSeen = false
  const { primaryTag, fallbackTag } = pendingPrereleaseFallback
  const url = getReleaseDownloadUrl(fallbackTag)
  console.info(
    `[updater] prerelease manifest missing for ${primaryTag}; retrying once against ${url}`
  )
  const autoUpdater = getAutoUpdater()
  autoUpdater.setFeedURL({ provider: 'generic', url })
  userInitiatedCheck = Boolean(userInitiated)
  backgroundCheckLaunchPending = !userInitiated
  armUpdateCheckStallTimer(attemptId)
  markUpdateCheckLaunched(attemptId)
  void autoUpdater
    .checkForUpdates()
    .then(() => handleSettledUpdateCheckPromise(attemptId))
    .catch((err) => {
      if (!isActiveUpdateCheckAttempt(attemptId)) {
        return
      }
      const message = String(err?.message ?? err)
      if (userInitiated) {
        userInitiatedCheck = false
      } else {
        backgroundCheckLaunchPending = false
      }
      markMissingManifestPrereleaseFallbackPromiseHandled(message)
      consumeMissingManifestPrereleaseFallbackResult()
      void sendCheckFailureStatus(message, userInitiated, 'fallback-promise', err)
    })
  return true
}

/** Returns false when the check was deferred instead of launched, so timer-driven callers can re-arm. */
function runBackgroundUpdateCheck(
  nudgeId: string | null = getPersistedPendingUpdateNudgeId()
): boolean {
  // Why: a pinned dev jump owns the feed until it settles; a background check
  // would repoint it mid-flight and download the wrong build.
  if (
    activeUpdateSource !== 'release' ||
    isPinnedBuildActive ||
    localBuildSelectionInProgress ||
    pinnedBuildSelectionInProgress
  ) {
    return false
  }
  if (backgroundCheckLaunchPending || currentStatus.state === 'checking') {
    return false
  }
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available' })
    return false
  }
  // Why: set the nudge marker before any events arrive so later checks can't inherit a stale campaign id; persisted id keeps a nudge card dismissable after relaunch.
  activeUpdateNudgeId = nudgeId
  // Why: 'checking-for-update' arrives a tick later, so a second focus/resume can slip in before status flips; track launch in memory to dedupe that gap.
  backgroundCheckLaunchPending = true
  backgroundCheckPromotedToUserInitiated = false
  const attemptId = beginUpdateCheckAttempt()
  // Don't send 'checking' here — the 'checking-for-update' handler does; sending from both dupes notifications (issue #35).
  const autoUpdater = getAutoUpdater()
  const launch = (): Promise<unknown> | undefined => {
    if (!isActiveUpdateCheckAttempt(attemptId)) {
      return undefined
    }
    markUpdateCheckLaunched(attemptId)
    return autoUpdater.checkForUpdates()
  }
  const run = pinDefaultReleaseFeed().then(launch)
  void Promise.resolve(run)
    .then(() => handleSettledUpdateCheckPromise(attemptId))
    .catch((err) => {
      if (!isActiveUpdateCheckAttempt(attemptId)) {
        return
      }
      const wasUserInitiated = getSettledCheckUserInitiated()
      backgroundCheckLaunchPending = false
      backgroundCheckPromotedToUserInitiated = false
      if (wasUserInitiated) {
        userInitiatedCheck = false
      }
      void sendCheckFailureStatus(String(err?.message ?? err), wasUserInitiated, 'promise', err)
    })
  return true
}

export function checkForUpdates(): void {
  // Why: span records only check launch (always Success), not outcome; dashboards must filter `updater.outcome === 'launched'`, not this span's success rate.
  void withUpdaterSpan({ stage: 'check' }, async (span) => {
    span.setAttribute('updater.outcome', 'launched')
    runBackgroundUpdateCheck()
  })
}

function enablePrereleaseManifestChecks(): void {
  getAutoUpdater().allowPrerelease = true
}

function enableIncludePrerelease(): void {
  if (includePrereleaseActive) {
    return
  }
  // Why: this flag makes electron-updater accept prerelease manifests; we keep the manifest-probed generic feed over the native GitHub provider because cancelled RCs can appear without assets.
  enablePrereleaseManifestChecks()
  includePrereleaseActive = true
}

/** Menu-triggered check — delegates feedback to renderer toasts via userInitiated flag */
export function checkForUpdatesFromMenu(options?: UpdateCheckOptions): void {
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available', userInitiated: true })
    return
  }
  if (options?.localBuild) {
    void checkForLocalBuildFromMenu()
    return
  }
  if (options?.targetTag && options.channel) {
    void checkForPinnedBuild(options.channel, options.targetTag)
    return
  }
  if (localBuildSelectionInProgress || pinnedBuildSelectionInProgress) {
    return
  }
  if (
    activeUpdateSource !== 'release' &&
    (currentStatus.state === 'checking' || currentStatus.state === 'downloading')
  ) {
    return
  }
  restoreReleaseUpdateSource()

  const checkVariant = getUpdateCheckVariant(options)
  if (checkVariant === 'prerelease') {
    clearPrereleaseFallbackContext()
    enableIncludePrerelease()
  } else if (checkVariant === 'perf') {
    clearPrereleaseFallbackContext()
    // Why: perf checks need prerelease manifests now, but must not opt future default/background checks into the RC channel.
    enablePrereleaseManifestChecks()
  }

  const checkAlreadyInFlight = backgroundCheckLaunchPending || currentStatus.state === 'checking'
  userInitiatedCheck = true
  // Why: manual checks are nudge-independent; clear the marker so a later dismiss can't consume the campaign by accident.
  activeUpdateNudgeId = null
  // Why: respond visibly before feed pinning/updater events; duplicate broadcasts are suppressed by status equality below.
  sendStatus({ state: 'checking', userInitiated: true })
  if (checkAlreadyInFlight) {
    backgroundCheckPromotedToUserInitiated = true
    rearmActiveUpdateCheckStallTimer()
    if (checkVariant !== 'default') {
      // Why: in-flight check may have pinned the stable feed; queue a fresh modifier check to avoid a stale-channel result.
      pendingUserInitiatedCheckAfterInFlight = checkVariant
    }
    return
  }

  const attemptId = beginUpdateCheckAttempt()
  const autoUpdater = getAutoUpdater()
  const launch = (): Promise<unknown> | undefined => {
    if (!isActiveUpdateCheckAttempt(attemptId)) {
      return undefined
    }
    markUpdateCheckLaunched(attemptId)
    return autoUpdater.checkForUpdates()
  }
  const run = pinDefaultReleaseFeed(checkVariant).then((preflightResult) => {
    if (preflightResult === 'not-available') {
      if (!isActiveUpdateCheckAttempt(attemptId)) {
        return false
      }
      userInitiatedCheck = false
      finishActiveUpdateCheckAttempt()
      recordCompletedUpdateCheck()
      sendStatus({ state: 'not-available', userInitiated: true })
      return false
    }
    return launch()
  })
  void Promise.resolve(run)
    .then((launchResult) => {
      if (launchResult === false) {
        return
      }
      handleSettledUpdateCheckPromise(attemptId)
    })
    .catch((err) => {
      if (!isActiveUpdateCheckAttempt(attemptId)) {
        return
      }
      userInitiatedCheck = false
      void sendCheckFailureStatus(String(err?.message ?? err), true, 'promise', err)
    })
}

async function checkForLocalBuildFromMenu(): Promise<void> {
  if (process.platform !== 'darwin') {
    sendLocalBuildErrorAndRestore(
      'Local build switching is currently available only on macOS.',
      true
    )
    return
  }
  if (currentStatus.state === 'checking' || currentStatus.state === 'downloading') {
    return
  }
  if (localBuildSelectionInProgress) {
    return
  }
  localBuildSelectionInProgress = true
  try {
    const [{ chooseLocalBuild }, { startLocalBuildFeed }] = await Promise.all([
      import('./local-builds/local-build-switch'),
      import('./local-builds/local-build-feed-server')
    ])
    const candidate = await chooseLocalBuild(mainWindowRef)
    if (!candidate) {
      return
    }
    closeLocalBuildFeed()
    const feed = await startLocalBuildFeed(candidate)
    activeLocalBuildFeed = feed
    activeUpdateSource = 'local'
    clearPrereleaseFallbackContext()
    clearPublishingWindowLastGoodCheck()
    clearAvailableUpdateContext()
    activeUpdateNudgeId = null
    userInitiatedCheck = true
    sendStatus({ state: 'checking', userInitiated: true })

    const updater = getAutoUpdater()
    updater.allowDowngrade = true
    updater.disableDifferentialDownload = true
    updater.setFeedURL({ provider: 'generic', url: feed.url })
    const attemptId = beginUpdateCheckAttempt()
    markUpdateCheckLaunched(attemptId)
    await updater.checkForUpdates()
    handleSettledUpdateCheckPromise(attemptId)
  } catch (error) {
    userInitiatedCheck = false
    sendLocalBuildErrorAndRestore(String((error as Error)?.message ?? error), true)
  } finally {
    localBuildSelectionInProgress = false
  }
}

export async function listAvailableReleaseBuilds(channel: ReleaseChannel): Promise<ReleaseBuild[]> {
  return listReleaseBuilds(channel)
}

/**
 * Pins the updater at one exact release tag and checks it, so a dev can move to
 * any published build on any channel — including an older one.
 *
 * Unlike a routine check this sets `allowDowngrade`, because "jump to yesterday's
 * hourly" is a downgrade by semver. The pin is torn down as soon as the attempt
 * settles so ordinary background checks never inherit it.
 */
async function checkForPinnedBuild(channel: ReleaseChannel, tag: string): Promise<void> {
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available', userInitiated: true })
    return
  }
  // Why here as well as in the picker: the renderer disables the option, but IPC
  // is reachable regardless, and there is no artifact to install off-macOS.
  if (!isChannelSupportedOnPlatform(channel, process.platform)) {
    sendStatus({
      state: 'error',
      message: `${RELEASE_CHANNEL_LABELS[channel]} builds are produced only for macOS.`,
      userInitiated: true
    })
    return
  }
  if (currentStatus.state === 'checking' || currentStatus.state === 'downloading') {
    return
  }
  if (localBuildSelectionInProgress || pinnedBuildSelectionInProgress) {
    return
  }
  pinnedBuildSelectionInProgress = true
  try {
    const target = resolveTargetBuild(channel, tag)
    if (compareVersions(target.version, app.getVersion()) === 0) {
      sendStatus({ state: 'not-available', userInitiated: true })
      return
    }
    closeLocalBuildFeed()
    activeUpdateSource = hasDedicatedReleaseRepo(channel) ? channel : 'release'
    isPinnedBuildActive = true
    clearPrereleaseFallbackContext()
    clearPublishingWindowLastGoodCheck()
    clearAvailableUpdateContext()
    activeUpdateNudgeId = null
    userInitiatedCheck = true
    sendStatus({ state: 'checking', userInitiated: true })

    const updater = getAutoUpdater()
    // Why: an intentional jump to an older tag must not be filtered out as "not newer".
    updater.allowDowngrade = true
    updater.disableDifferentialDownload = true
    updater.allowPrerelease = true
    console.info(`[updater] pinned to ${channel} build ${target.tag} → ${target.feedUrl}`)
    updater.setFeedURL({ provider: 'generic', url: target.feedUrl })
    availableReleaseUrl = target.feedUrl
    const attemptId = beginUpdateCheckAttempt()
    markUpdateCheckLaunched(attemptId)
    await updater.checkForUpdates()
    handleSettledUpdateCheckPromise(attemptId)
  } catch (error) {
    userInitiatedCheck = false
    clearAvailableUpdateContext()
    restoreReleaseUpdateSource()
    sendStatus({
      state: 'error',
      message: String((error as Error)?.message ?? error),
      userInitiated: true
    })
  } finally {
    pinnedBuildSelectionInProgress = false
  }
}

export function isQuittingForUpdate(): boolean {
  return quittingForUpdate
}

function getActiveLinuxPackageRecovery(): LinuxPackageInstallRecovery | null {
  if (currentStatus.state !== 'error') {
    return null
  }
  return currentStatus.recovery?.kind === 'linux-package-install' ? currentStatus.recovery : null
}

const LINUX_PACKAGE_RECOVERY_MESSAGES: Record<LinuxPackageRecoveryUnavailableReason, string> = {
  missing:
    'The downloaded package is no longer in the update cache. Download the update again, or get it from the official release page.',
  // Why: this reason also covers a path that left the cache (traversal or symlinked parent), so the copy must not promise the file merely changed type.
  'not-regular':
    'The downloaded package is no longer a valid file in the update cache. Download the update again, or get it from the official release page.',
  'hash-mismatch':
    'The downloaded package no longer matches the verified release, so Orca will not hand it to a package manager. Download the update again, or get it from the official release page.',
  'read-failed':
    'Orca could not read the downloaded package. Download the update again, or get it from the official release page.',
  'no-sudo':
    'No sudo command was found in the system directories, so Orca cannot build a safe install command. Show the package and install it with your package manager.',
  'no-package-manager':
    'No supported package manager was found in the system directories, so Orca cannot build a safe install command. Show the package and install it with your package manager.',
  // Defensive: capture only ever tracks absolute cache paths, so this reports a bug rather than a machine state.
  'invalid-package-path':
    'The downloaded package is not at a usable path, so Orca cannot build a safe install command. Show the package and install it with your package manager.'
}

// Why: clearing the artifact alone would leave the renderer's actions enabled; the status must lose its recovery too.
const RECOVERY_CLEARING_REASONS: LinuxPackageRecoveryUnavailableReason[] = [
  'missing',
  'not-regular',
  'hash-mismatch'
]

function recordLinuxPackageRecoveryUnavailable(
  recovery: LinuxPackageInstallRecovery,
  reason: LinuxPackageRecoveryUnavailableReason
): void {
  recordUpdaterLifecycle(
    'linux_package_recovery_unavailable',
    { reason, packageType: recovery.packageType, version: recovery.version },
    { level: 'warn', message: 'Linux package recovery action unavailable' }
  )
}

function failLinuxPackageRecovery(
  recovery: LinuxPackageInstallRecovery,
  reason: LinuxPackageRecoveryUnavailableReason
): never {
  recordLinuxPackageRecoveryUnavailable(recovery, reason)
  const message = LINUX_PACKAGE_RECOVERY_MESSAGES[reason]
  // Why: hashing 160 MB takes long enough for a new cycle to land. Acting on a stale verdict would
  // destroy the newer artifact and clobber whatever card replaced this one.
  const active = getActiveLinuxPackageRecovery()
  const stillCurrent =
    active?.version === recovery.version && active?.packageType === recovery.packageType
  if (stillCurrent && RECOVERY_CLEARING_REASONS.includes(reason)) {
    clearTrackedLinuxPackageArtifact()
    sendStatus({ state: 'error', message })
  }
  throw new Error(message)
}

/**
 * Identifies the update cycle an install belongs to, so a verdict produced by a multi-second hash
 * can be dropped when a newer cycle already replaced the card it would otherwise overwrite.
 */
function getInstallCycleSignature(): string {
  const recovery = getActiveLinuxPackageRecovery()
  if (recovery) {
    return `recovery:${recovery.packageType}:${recovery.version}`
  }
  return currentStatus.state === 'downloaded'
    ? `downloaded:${currentStatus.version}`
    : `state:${currentStatus.state}`
}

/**
 * Re-proves the retained package before the install starts. Returns false when the install must be
 * abandoned; the artifact is only re-read here, so callers still own every teardown decision.
 */
async function proveRetainedLinuxPackage(pendingVersion: string): Promise<boolean> {
  const artifact = getTrackedLinuxPackageArtifact()
  if (!artifact) {
    return true
  }
  // Why: an artifact retained from another cycle says nothing about the file electron-updater is
  // about to install, so proving it would block a legitimate install on an unrelated digest.
  if (pendingVersion && pendingVersion !== artifact.version) {
    return true
  }
  const recovery = getActiveLinuxPackageRecovery()
  const cycle = getInstallCycleSignature()
  const reason = await revalidateRetainedLinuxPackage(artifact)
  if (!reason) {
    return true
  }
  reportLinuxPackageRevalidationFailure({ artifact, recovery, reason, cycle })
  return false
}

/** The failing reason, or null when the retained package still matches its release digest. */
async function revalidateRetainedLinuxPackage(
  artifact: LinuxPackageArtifact
): Promise<LinuxPackageRecoveryUnavailableReason | null> {
  linuxPackageRevalidationInFlight = true
  try {
    const verdict = await revalidateLinuxPackageForInstall(artifact)
    return verdict.ok ? null : verdict.reason
  } catch (error) {
    recordUpdaterLifecycle(
      'linux_package_revalidation_errored',
      { errorType: error instanceof Error ? error.name : typeof error },
      { level: 'warn', message: 'Could not re-verify the retained update package' }
    )
    // Why: fail closed — bytes we could not read are bytes we cannot hand to a root installer.
    return 'read-failed'
  } finally {
    // Why: the invariant every install path depends on — a wedged flag would make quitAndInstall
    // early-return for the rest of the session.
    linuxPackageRevalidationInFlight = false
  }
}

function reportLinuxPackageRevalidationFailure({
  artifact,
  recovery,
  reason,
  cycle
}: {
  artifact: LinuxPackageArtifact
  recovery: LinuxPackageInstallRecovery | null
  reason: LinuxPackageRecoveryUnavailableReason
  cycle: string
}): void {
  recordUpdaterLifecycle(
    'linux_package_revalidation_failed',
    {
      action: recovery ? 'retry-automatic' : 'restart-to-install',
      packageType: artifact.packageType,
      version: artifact.version,
      reason
    },
    { level: 'warn', message: 'Retained update package failed its pre-install digest check' }
  )
  // Why: a package proven bad must not stay tracked, but a download that landed during the hash
  // owns the slot now and destroying it would force a needless 160 MB redownload.
  const clearsArtifact = RECOVERY_CLEARING_REASONS.includes(reason)
  if (clearsArtifact && getTrackedLinuxPackageArtifact() === artifact) {
    clearTrackedLinuxPackageArtifact()
  }
  // Why: same reasoning as failLinuxPackageRecovery — a verdict from a cycle that has since been
  // replaced must not clobber whatever card the user is looking at now.
  if (getInstallCycleSignature() !== cycle) {
    return
  }
  sendInstallFailureStatus({
    state: 'error',
    message: LINUX_PACKAGE_RECOVERY_MESSAGES[reason],
    // Why: an unreadable file is not evidence the bytes changed, so the recovery card and its
    // Copy/Show actions survive a transient I/O failure exactly as they do elsewhere.
    ...(recovery && !clearsArtifact ? { recovery } : {})
  })
}

export async function getLinuxPackageInstallInstructions(): Promise<LinuxPackageInstallInstructions> {
  const recovery = getActiveLinuxPackageRecovery()
  if (!recovery) {
    throw new Error('No package install recovery is available.')
  }
  recordUpdaterLifecycle('linux_package_recovery_requested', {
    action: 'copy-command',
    packageType: recovery.packageType,
    version: recovery.version
  })
  const result = await resolveLinuxPackageInstallInstructions(recovery)
  if (!result.ok) {
    // Why: the renderer must distinguish "this machine has no package manager" (keep the card, promote
    // Show Package) from "the artifact is gone" (recovery is cleared and the card unmounts).
    if (result.reason === 'no-sudo' || result.reason === 'no-package-manager') {
      recordLinuxPackageRecoveryUnavailable(recovery, result.reason)
      return {
        ok: false,
        reason: result.reason,
        message: LINUX_PACKAGE_RECOVERY_MESSAGES[result.reason]
      }
    }
    failLinuxPackageRecovery(recovery, result.reason)
  }
  return { ok: true, command: result.command, packageFileName: result.packageFileName }
}

export async function showLinuxPackage(): Promise<void> {
  const recovery = getActiveLinuxPackageRecovery()
  if (!recovery) {
    throw new Error('No package install recovery is available.')
  }
  recordUpdaterLifecycle('linux_package_recovery_requested', {
    action: 'show-package',
    packageType: recovery.packageType,
    version: recovery.version
  })
  const result = await revealLinuxPackage(recovery)
  if (!result.ok) {
    failLinuxPackageRecovery(recovery, result.reason)
  }
}

export function quitAndInstall(): void {
  if (
    localBuildSelectionInProgress ||
    pinnedBuildSelectionInProgress ||
    pendingQuitAndInstallTimer ||
    quitAndInstallInProgress ||
    // Why: the quit timer is already cleared while the pre-install digest re-proof streams, so
    // without this a second click would schedule a parallel install of the same package.
    linuxPackageRevalidationInFlight
  ) {
    return
  }

  const retriedRecovery = getActiveLinuxPackageRecovery()
  if (retriedRecovery) {
    recordUpdaterLifecycle('linux_package_recovery_requested', {
      action: 'retry-automatic',
      packageType: retriedRecovery.packageType,
      version: retriedRecovery.version
    })
  }

  if (deferHeadlessServeInstall('install', getPendingInstallVersion())) {
    return
  }

  if (
    deferMacQuitUntilInstallerReady(
      currentStatus,
      hasInstallableDownloadedVersion(),
      getPendingInstallVersion,
      sendStatus
    )
  ) {
    return
  }

  // Why: defer the quit a tick so the renderer can flush dismissals/state before windows start closing.
  pendingQuitAndInstallTimer = setTimeout(() => {
    void performQuitAndInstall()
  }, QUIT_AND_INSTALL_DELAY_MS)
}

async function checkForUpdateNudge(): Promise<void> {
  if (!app.isPackaged || is.dev) {
    return
  }
  if (nudgeCheckInFlight) {
    return
  }

  const now = Date.now()
  if (now - lastNudgeCheckAt < NUDGE_ACTIVATION_COOLDOWN_MS) {
    return
  }
  lastNudgeCheckAt = now

  nudgeCheckInFlight = true
  try {
    const nudge = await fetchNudge()
    if (!nudge) {
      return
    }

    if (currentStatus.state === 'checking' || currentStatus.state === 'downloading') {
      return
    }

    const appVersion = app.getVersion()
    const pendingUpdateNudgeId = _getPendingUpdateNudgeId?.() ?? null
    const dismissedUpdateNudgeId = _getDismissedUpdateNudgeId?.() ?? null

    if (
      shouldApplyNudge({
        nudge,
        appVersion,
        pendingUpdateNudgeId,
        dismissedUpdateNudgeId
      })
    ) {
      awaitingNudgeCheckOutcome = true
      _setPendingUpdateNudgeId?.(nudge.id)
      mainWindowRef?.webContents.send('updater:clearDismissal')
      runBackgroundUpdateCheck(nudge.id)
    }
  } finally {
    nudgeCheckInFlight = false
  }
}

function scheduleUpdateNudgeCheck(): void {
  if (nudgeCheckTimer) {
    clearTimeout(nudgeCheckTimer)
  }
  nudgeCheckTimer = setTimeout(() => {
    void checkForUpdateNudge()
    scheduleUpdateNudgeCheck()
  }, NUDGE_POLL_INTERVAL_MS)
}

export function dismissNudge(): void {
  const pendingId = activeUpdateNudgeId ?? _getPendingUpdateNudgeId?.() ?? null
  if (pendingId) {
    _setDismissedUpdateNudgeId?.(pendingId)
    clearPendingUpdateNudge()
  }
}

/**
 * The user closed an offered update without taking it. For a local build or a
 * pinned dev jump that ends the session: nothing will consume that feed now, so
 * release checks must stop being deferred.
 */
export function dismissAvailableUpdate(): void {
  if (activeUpdateSource === 'release' && !isPinnedBuildActive) {
    return
  }
  if (localBuildSelectionInProgress || pinnedBuildSelectionInProgress) {
    return
  }
  // Why: only an un-acted 'available' card is abandoned — 'downloading'/'downloaded' still need the pinned feed and allowDowngrade.
  if (currentStatus.state !== 'available') {
    return
  }
  clearAvailableUpdateContext()
  restoreReleaseUpdateSource()
  // Why: leaving the card's 'available' status behind would let a retry download the local version off the restored release feed.
  sendStatus({ state: 'idle' })
}

export function setupAutoUpdater(
  mainWindow: BrowserWindow,
  opts?: {
    getLastUpdateCheckAt?: () => number | null
    onBeforeQuit?: () => void | Promise<void>
    setLastUpdateCheckAt?: (timestamp: number) => void
    getPendingUpdateNudgeId?: () => string | null
    getDismissedUpdateNudgeId?: () => string | null
    setPendingUpdateNudgeId?: (id: string | null) => void
    setDismissedUpdateNudgeId?: (id: string | null) => void
    getReleaseChannelOverride?: () => ReleaseChannel | null
    installMode?: UpdateInstallMode
  }
): void {
  mainWindowRef = mainWindow
  onBeforeQuitCleanup = opts?.onBeforeQuit ?? null
  persistLastUpdateCheckAt = opts?.setLastUpdateCheckAt ?? null
  _getLastUpdateCheckAt = opts?.getLastUpdateCheckAt ?? null
  _getPendingUpdateNudgeId = opts?.getPendingUpdateNudgeId ?? null
  _getDismissedUpdateNudgeId = opts?.getDismissedUpdateNudgeId ?? null
  _setPendingUpdateNudgeId = opts?.setPendingUpdateNudgeId ?? null
  _setDismissedUpdateNudgeId = opts?.setDismissedUpdateNudgeId ?? null
  getReleaseChannelOverride = opts?.getReleaseChannelOverride ?? null
  updateInstallMode = opts?.installMode ?? 'interactive'
  lastInstallDeferralVersion = { download: null, install: null }

  const serveHandoffFailure = getServeUpdateHandoffFailure()
  if (serveHandoffFailure) {
    recordUpdaterLifecycle(
      'headless_serve_handoff_failed',
      { reason: serveHandoffFailure },
      { level: 'warn', message: 'Supervised serve update did not complete' }
    )
    sendErrorStatus(`The server update did not complete: ${serveHandoffFailure}`, true)
  }

  if (!app.isPackaged && !is.dev) {
    return
  }
  if (is.dev) {
    return
  }

  const autoUpdater = getAutoUpdater()
  autoUpdater.autoDownload = false
  if (activeUpdateSource === 'release') {
    autoUpdater.allowDowngrade = false
    autoUpdater.disableDifferentialDownload = false
  }
  // Why: supervised serve installs require an explicit handoff; ordinary service quits must never install implicitly.
  // Root Linux packages also opt out: an implicit quit-time escalation would fail after the UI is gone, leaving no recovery surface.
  autoUpdater.autoInstallOnAppQuit =
    updateInstallMode === 'interactive' && getLinuxRootPackageType() === null
  // Why: MacUpdater ignores quitAndInstall arguments; the surviving CLI supervisor must be the only serve relaunch owner.
  autoUpdater.autoRunAppAfterInstall = updateInstallMode === 'interactive'

  // Why: our only on-machine window into electron-updater; otherwise an unexpected update-not-available or failed fetch is invisible.
  // The adapter also retains the redacted child stderr that BaseUpdater logs but drops from the 'error' event.
  autoUpdater.logger = createUpdaterDiagnosticLogger() as never

  // Security: never re-add a verifyUpdateCodeSignature override — a no-op disables electron-updater's built-in Authenticode check and accepts any installer.

  // Why: generic provider avoids the native GitHub provider's RC-channel filtering; per-check repinning to a concrete /releases/download/<tag>/ URL avoids /latest redirect drift between check and download.
  if (activeUpdateSource === 'release') {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    })
  }

  if (autoUpdaterInitialized) {
    return
  }
  autoUpdaterInitialized = true

  registerAutoUpdaterHandlers({
    autoUpdater,
    clearAvailableUpdateContext,
    consumeMissingManifestPrereleaseFallbackResult,
    getMissingManifestPrereleaseFallbackUserInitiated,
    getPublishingWindowLastGoodCheck,
    getActiveUpdateCheckEventAttemptId,
    getCurrentStatus: () => currentStatus,
    getKnownReleaseUrl,
    getPendingInstallVersion,
    getUserInitiatedCheck: () => userInitiatedCheck,
    handleQuitAndInstallFailure,
    isQuitAndInstallHandoffActive,
    hasInstallableDownloadedVersion,
    isLocalBuildCheck: () => activeUpdateSource === 'local',
    // Why: pinned jumps are deliberate, so update-available/-downloaded must not
    // reject them for being older than the running version.
    isPinnedBuildCheck: () => isPinnedBuildActive,
    shouldHandleUpdaterErrorEvent,
    performQuitAndInstall,
    clearUpdateAvailableEventPending,
    isActiveUpdateCheckAttempt,
    markUpdateCheckEventAttempt,
    markUpdateAvailableEventPending,
    sendCheckFailureStatus,
    sendErrorStatus,
    markMissingManifestPrereleaseFallbackChecking,
    shouldDeferMacQuitForInstall: () => updateInstallMode === 'interactive',
    shouldSuppressMissingManifestPrereleaseFallbackEvent,
    suppressMissingManifestPrereleaseFallbackPromiseFailure,
    recordCompletedUpdateCheck,
    restoreReleaseUpdateSource,
    sendStatus,
    scheduleAutomaticUpdateCheck,
    clearBackgroundCheckLaunchPending,
    setAvailableReleaseUrl: (releaseUrl) => {
      availableReleaseUrl = releaseUrl
    },
    setAvailableVersion: (version) => {
      availableVersion = version
    },
    setUserInitiatedCheck: (value) => {
      userInitiatedCheck = value
    }
  })

  void checkForUpdateNudge()
  scheduleUpdateNudgeCheck()

  const checkDailyOnWake = () => {
    void checkForUpdateNudge()
    if (
      backgroundCheckLaunchPending ||
      currentStatus.state === 'checking' ||
      currentStatus.state === 'downloading'
    ) {
      return
    }
    const lastCheck = _getLastUpdateCheckAt?.() ?? null
    const msSince = lastCheck === null ? Number.POSITIVE_INFINITY : Date.now() - lastCheck
    if (msSince >= AUTO_UPDATE_CHECK_INTERVAL_MS) {
      runBackgroundUpdateCheck()
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
    }
  }

  powerMonitor.on('resume', checkDailyOnWake)
  app.on('browser-window-focus', checkDailyOnWake)

  const lastUpdateCheckAt = opts?.getLastUpdateCheckAt?.() ?? null
  const msSinceLastCheck =
    lastUpdateCheckAt === null ? Number.POSITIVE_INFINITY : Date.now() - lastUpdateCheckAt

  if (msSinceLastCheck >= AUTO_UPDATE_CHECK_INTERVAL_MS) {
    runBackgroundUpdateCheck()
    scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
  } else {
    scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS - msSinceLastCheck)
  }
}

export function downloadUpdate(): void {
  if (localBuildSelectionInProgress || pinnedBuildSelectionInProgress || downloadInFlight) {
    return
  }
  // Why: allow retry from 'error' (availableVersion stays cached) so the error card's Retry Download button works.
  const canStart =
    currentStatus.state === 'available' ||
    (currentStatus.state === 'error' && hasInstallableDownloadedVersion())
  if (!canStart) {
    return
  }
  const version = currentStatus.state === 'available' ? currentStatus.version : availableVersion
  if (!version) {
    return
  }
  if (deferHeadlessServeInstall('download', version)) {
    return
  }
  downloadInFlight = true
  const localBuildDownload = activeUpdateSource === 'local'
  beginMacUpdateDownload()
  // Why: setup can take seconds before progress emits; surface acceptance now so the action never looks inert.
  sendStatus({ state: 'downloading', percent: 0, version })
  getAutoUpdater()
    .downloadUpdate()
    .catch((err) => {
      downloadInFlight = false
      const message = String(err?.message ?? err)
      if (localBuildDownload) {
        sendLocalBuildErrorAndRestore(message)
      } else {
        sendErrorStatus(message)
      }
    })
}
