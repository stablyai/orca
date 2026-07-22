/* eslint-disable max-lines */
import { app, BrowserWindow, powerMonitor } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { UpdateCheckOptions, UpdateStatus } from '../shared/types'
import { isWindowsSignatureCheckUnavailableFailure } from '../shared/updater-windows-signature-check'
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
import {
  compareVersions,
  isBenignCheckFailure,
  isMissingUpdateManifestFailure,
  isPrereleaseVersion,
  isReleaseAssetsPublishingFailure,
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

type CheckFailureSource = 'event' | 'promise' | 'fallback-promise'
type MissingManifestPrereleaseFallbackResult = { userInitiated: boolean }
type PrimaryEventSuppression = { failureKey: string; error: unknown }
type UpdateCheckVariant = 'default' | 'prerelease' | 'perf'
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
let updateInstallMode: UpdateInstallMode = 'interactive'
let lastInstallDeferralVersion = { download: null as string | null, install: null as string | null }
// Why: once install has committed, late 'error' events must not clear quittingForUpdate — that would re-enable dock activate mid-installer.
let updateInstallCommitted = false
// Why: recovery must only run after the native quitAndInstall call; pre-native errors must not clear quittingForUpdate or look like install recovery.
let quitAndInstallNativeInvoked = false
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

function sendStatus(status: UpdateStatus): void {
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

  const decoratedStatus = decorateStatusWithActiveNudge(status)

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
    launchPendingUserInitiatedCheckAfterInFlight(pendingUserInitiatedCheckVariant)
    return
  }
  if (statusesEqual(currentStatus, decoratedStatus)) {
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

function hasNewerDownloadedVersion(): boolean {
  return availableVersion !== null && compareVersions(availableVersion, app.getVersion()) > 0
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
  if (quitAndInstallInProgress) {
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
      getAutoUpdater().quitAndInstall(supervisorOwnsRelaunch, !supervisorOwnsRelaunch)
      span.addEvent('native_quit_and_install_invoked')

      // Why: quitAndInstall can synchronously clear quitAndInstallInProgress via recovery (Win/Linux dispatchError); skip destructive prep if it already ran.
      if (!quitAndInstallInProgress) {
        return
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
      if (process.platform !== 'darwin' || isMacInstallerReady()) {
        updateInstallCommitted = true
        // Why: past commit the installer waits for this process to exit; a wedged async shutdown would strand the user with no app and no update (#4438).
        armUpdateInstallExitWatchdog()
      }
    })
  } catch (error) {
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
    sendErrorStatus(
      'Could not restart to install the update. Quit and reopen Orca, then try again.'
    )
  }
}

function resetQuitForUpdateState(): void {
  quitAndInstallInProgress = false
  quittingForUpdate = false
  updateInstallCommitted = false
  quitAndInstallNativeInvoked = false
  disarmUpdateInstallExitWatchdog()
  resetMacInstallState()
}

// Why: quitAndInstall failures arrive via 'error'; recover only after native invoke and before commit, else clearing quittingForUpdate lets dock activate reopen the old process mid-installer.
function handleQuitAndInstallFailure(): boolean {
  if (!quitAndInstallInProgress || !quitAndInstallNativeInvoked || updateInstallCommitted) {
    return false
  }
  failServeUpdateHandoff('The native updater rejected the install request.')
  resetQuitForUpdateState()
  recordUpdaterLifecycle('quit_and_install_failed_via_event', undefined, {
    level: 'warn',
    message: 'Update install could not start; recovered app state'
  })
  sendErrorStatus('Could not restart to install the update. Quit and reopen Orca, then try again.')
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
    if (isBenignCheckFailure(message)) {
      // Why: benign failures (publishing latest.yml, network blips) are transient — retry, and skip persisting the timestamp (would suppress the next startup check).
      console.warn('[updater] benign check failure:', message)
      clearAvailableUpdateContext()
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      if (userInitiated) {
        // Why: a user click needs visible feedback (idle looks broken); the UI already prefixes context, so this carries only the actionable cause.
        sendErrorStatus("Couldn't reach the update server. Try again in a few minutes.", true)
      } else {
        if (isReleaseAssetsPublishingFailure(message)) {
          // Why: a nudge check can land while GitHub exposes a release before its assets; keep the campaign pending so the short retry can show it.
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

export function getUpdateStatus(): UpdateStatus {
  return currentStatus
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
    runBackgroundUpdateCheck()
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
      `[updater] release feed deferred: current=${currentVersion} includePrerelease=${includePrerelease}; newest release assets are still publishing`
    )
    throw new Error('Latest release assets are still publishing')
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

function runBackgroundUpdateCheck(
  nudgeId: string | null = getPersistedPendingUpdateNudgeId()
): void {
  if (backgroundCheckLaunchPending || currentStatus.state === 'checking') {
    return
  }
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available' })
    return
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

export function isQuittingForUpdate(): boolean {
  return quittingForUpdate
}

export function quitAndInstall(): void {
  if (pendingQuitAndInstallTimer || quitAndInstallInProgress) {
    return
  }

  if (deferHeadlessServeInstall('install', getPendingInstallVersion())) {
    return
  }

  if (
    deferMacQuitUntilInstallerReady(
      currentStatus,
      hasNewerDownloadedVersion(),
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
  // Why: supervised serve installs require an explicit handoff; ordinary service quits must never install implicitly.
  autoUpdater.autoInstallOnAppQuit = updateInstallMode === 'interactive'
  // Why: MacUpdater ignores quitAndInstall arguments; the surviving CLI supervisor must be the only serve relaunch owner.
  autoUpdater.autoRunAppAfterInstall = updateInstallMode === 'interactive'

  // Why: our only on-machine window into electron-updater; otherwise an unexpected update-not-available or failed fetch is invisible.
  autoUpdater.logger = {
    info: (m: unknown) => console.info('[autoUpdater]', m),
    warn: (m: unknown) => console.warn('[autoUpdater]', m),
    error: (m: unknown) => console.error('[autoUpdater]', m),
    debug: (m: unknown) => console.debug('[autoUpdater]', m)
  } as never

  // Security: never re-add a verifyUpdateCodeSignature override — a no-op disables electron-updater's built-in Authenticode check and accepts any installer.

  // Why: generic provider avoids the native GitHub provider's RC-channel filtering; per-check repinning to a concrete /releases/download/<tag>/ URL avoids /latest redirect drift between check and download.
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: 'https://github.com/stablyai/orca/releases/latest/download'
  })

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
    hasNewerDownloadedVersion,
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
  if (downloadInFlight) {
    return
  }
  // Why: allow retry from 'error' (availableVersion stays cached) so the error card's Retry Download button works.
  const canStart =
    currentStatus.state === 'available' ||
    (currentStatus.state === 'error' && hasNewerDownloadedVersion())
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
  beginMacUpdateDownload()
  // Why: setup can take seconds before progress emits; surface acceptance now so the action never looks inert.
  sendStatus({ state: 'downloading', percent: 0, version })
  getAutoUpdater()
    .downloadUpdate()
    .catch((err) => {
      downloadInFlight = false
      sendErrorStatus(String(err?.message ?? err))
    })
}
