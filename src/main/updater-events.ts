import { app } from 'electron'
import {
  isMacInstallerReady,
  registerMacUpdaterEvents,
  resetMacInstallState
} from './updater-mac-install'
import { compareVersions } from './updater-fallback'
import { fetchChangelog } from './updater-changelog'
import type { UpdaterHandlerContext } from './updater-handler-context'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'
import {
  getRetainedLinuxPackageManualInstallStatus,
  resolveLinuxPackageDownloadedStatus,
  shouldIgnoreDownloadedUpdateEvent
} from './linux-package-downloaded-status'
import { isExternallyManagedLinuxInstall } from './linux-update-package-type'
import * as linuxPackageRecovery from './linux-package-update-recovery'
import { preExtractDownloadedAppImageUpdate } from './cli/appimage-copy-pre-extraction'

const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const AUTO_UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000

export function registerAutoUpdaterHandlers({
  autoUpdater,
  clearBackgroundCheckLaunchPending,
  clearAvailableUpdateContext,
  consumeMissingManifestPrereleaseFallbackResult,
  getPublishingWindowLastGoodCheck,
  getMissingManifestPrereleaseFallbackUserInitiated,
  getCurrentStatus,
  getActiveUpdateCheckEventAttemptId,
  getKnownReleaseUrl,
  getPendingInstallVersion,
  getUserInitiatedCheck,
  handleQuitAndInstallFailure,
  isQuitAndInstallHandoffActive,
  hasInstallableDownloadedVersion,
  isLocalBuildCheck,
  isPinnedBuildCheck,
  shouldHandleUpdaterErrorEvent,
  clearUpdateAvailableEventPending,
  isActiveUpdateCheckAttempt,
  markUpdateCheckEventAttempt,
  markUpdateAvailableEventPending,
  markMissingManifestPrereleaseFallbackChecking,
  performQuitAndInstall,
  commitStagedMacInstall,
  failMacStaging,
  isAwaitingMacStaging,
  isMacStagingDeferredToInstall,
  shouldDeferMacQuitForInstall,
  recordCompletedUpdateCheck,
  restoreReleaseUpdateSource,
  sendCheckFailureStatus,
  sendErrorStatus,
  sendStatus,
  scheduleAutomaticUpdateCheck,
  shouldSuppressMissingManifestPrereleaseFallbackEvent,
  suppressMissingManifestPrereleaseFallbackPromiseFailure,
  setAvailableReleaseUrl,
  setAvailableVersion,
  setUserInitiatedCheck
}: UpdaterHandlerContext): void {
  registerMacUpdaterEvents({
    getCurrentStatus,
    hasInstallableDownloadedVersion,
    getPendingInstallVersion,
    getKnownReleaseUrl,
    performQuitAndInstall,
    commitStagedMacInstall,
    failMacStaging,
    shouldDeferMacQuitForInstall,
    sendStatus
  })

  autoUpdater.on('checking-for-update', () => {
    if (!markUpdateCheckEventAttempt()) {
      return
    }
    clearBackgroundCheckLaunchPending()
    resetMacInstallState()
    clearAvailableUpdateContext()
    markMissingManifestPrereleaseFallbackChecking()
    const fallbackUserInitiated = getMissingManifestPrereleaseFallbackUserInitiated()
    const wasUserInitiated = fallbackUserInitiated ?? getUserInitiatedCheck()
    sendStatus({ state: 'checking', userInitiated: wasUserInitiated || undefined })
  })

  autoUpdater.on('update-available', (info) => {
    const attemptId = getActiveUpdateCheckEventAttemptId()
    if (attemptId === null) {
      return
    }
    clearBackgroundCheckLaunchPending()
    const missingManifestFallback = consumeMissingManifestPrereleaseFallbackResult()
    const publishingWindowLastGoodCheck = getPublishingWindowLastGoodCheck()
    const wasUserInitiated = missingManifestFallback?.userInitiated ?? getUserInitiatedCheck()
    setUserInitiatedCheck(false)

    // Explicit local or pinned builds may downgrade; release checks remain newer-only.
    if (
      !isLocalBuildCheck() &&
      !isPinnedBuildCheck() &&
      compareVersions(info.version, app.getVersion()) <= 0
    ) {
      clearAvailableUpdateContext()
      if (missingManifestFallback || publishingWindowLastGoodCheck) {
        // A missing primary manifest is transient; retain the short retry cadence.
        scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      } else {
        recordCompletedUpdateCheck()
        if (!wasUserInitiated) {
          scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
        }
      }
      sendStatus(
        getRetainedLinuxPackageManualInstallStatus() ?? {
          state: 'not-available',
          userInitiated: wasUserInitiated || undefined
        }
      )
      return
    }

    // A transiently older offer must not discard the retained recovery package.
    linuxPackageRecovery.clearTrackedLinuxPackageArtifactForOtherVersion(info.version)

    markUpdateAvailableEventPending(attemptId)
    void (async () => {
      try {
        const changelog =
          isLocalBuildCheck() || isPinnedBuildCheck()
            ? null
            : await fetchChangelog(info.version, app.getVersion()).catch(() => null)

        if (!isActiveUpdateCheckAttempt(attemptId)) {
          return
        }
        if (getCurrentStatus().state !== 'checking' && getCurrentStatus().state !== 'idle') {
          return
        }

        // A concurrent error during the fetch must not leave stale available state.
        setAvailableVersion(info.version)
        setAvailableReleaseUrl(null)
        // Dev jumps must not suppress real background checks by persisting lastUpdateCheckAt.
        if (!isLocalBuildCheck() && !isPinnedBuildCheck()) {
          if (missingManifestFallback || publishingWindowLastGoodCheck) {
            // Keep probing until the newest release finishes publishing.
            scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
          } else {
            recordCompletedUpdateCheck()
            if (!wasUserInitiated) {
              scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
            }
          }
        }

        sendStatus(
          getRetainedLinuxPackageManualInstallStatus() ?? {
            state: 'available',
            version: info.version,
            changelog,
            // Tell clients this host cannot self-update before offering a download.
            ...(isExternallyManagedLinuxInstall() ? { externallyManaged: true } : {})
          }
        )
      } finally {
        clearUpdateAvailableEventPending(attemptId)
      }
    })()
  })

  autoUpdater.on('update-not-available', () => {
    if (getActiveUpdateCheckEventAttemptId() === null) {
      return
    }
    clearBackgroundCheckLaunchPending()
    resetMacInstallState()
    const retainedStatus = getRetainedLinuxPackageManualInstallStatus()
    const missingManifestFallback = consumeMissingManifestPrereleaseFallbackResult()
    const publishingWindowLastGoodCheck = getPublishingWindowLastGoodCheck()
    const wasUserInitiated = missingManifestFallback?.userInitiated ?? getUserInitiatedCheck()
    const localBuildCheck = isLocalBuildCheck()
    // Release the pin after unpinned outcomes so later background checks can change feeds.
    const pinnedBuildCheck = isPinnedBuildCheck()
    setUserInitiatedCheck(false)
    clearAvailableUpdateContext()
    if (!localBuildCheck && !pinnedBuildCheck) {
      if (missingManifestFallback || publishingWindowLastGoodCheck) {
        // Transient publishing-window results must not defer checks for a full day.
        scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      } else {
        recordCompletedUpdateCheck()
        if (!wasUserInitiated) {
          scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
        }
      }
    }
    // Preserve manual-install recovery when a recheck finds no newer release.
    sendStatus(
      retainedStatus ?? { state: 'not-available', userInitiated: wasUserInitiated || undefined }
    )
    if (localBuildCheck || pinnedBuildCheck) {
      restoreReleaseUpdateSource()
    }
  })

  autoUpdater.on('download-progress', (progress) => {
    clearBackgroundCheckLaunchPending()
    const version = getPendingInstallVersion()
    linuxPackageRecovery.clearTrackedLinuxPackageArtifactForOtherVersion(version)
    sendStatus({
      state: 'downloading',
      percent: Math.round(progress.percent),
      version
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    // An older download can finish after a new target replaces it.
    if (
      shouldIgnoreDownloadedUpdateEvent(
        getCurrentStatus(),
        info.version,
        getPendingInstallVersion()
      )
    ) {
      return
    }
    clearBackgroundCheckLaunchPending()
    if (
      !isLocalBuildCheck() &&
      !isPinnedBuildCheck() &&
      compareVersions(info.version, app.getVersion()) <= 0
    ) {
      clearAvailableUpdateContext()
      linuxPackageRecovery.clearTrackedLinuxPackageArtifact()
      sendStatus({ state: 'not-available' })
      return
    }
    const macInstallerReady = process.platform === 'darwin' ? isMacInstallerReady() : true
    recordUpdaterLifecycle('update_downloaded', { version: info.version, macInstallerReady })
    // Launch the updated daemon from its unpacked runtime, not the mounted AppImage.
    void preExtractDownloadedAppImageUpdate(info.downloadedFile, (filePath) =>
      linuxPackageRecovery.isInUpdaterPendingCache(filePath)
    )
    const linuxPackageStatus = resolveLinuxPackageDownloadedStatus(info)
    if (linuxPackageStatus) {
      sendStatus(linuxPackageStatus)
      return
    }
    // Squirrel must finish staging before macOS can install.
    if (process.platform === 'darwin' && !macInstallerReady && !isMacStagingDeferredToInstall()) {
      recordUpdaterLifecycle('macos_waiting_for_squirrel', { version: info.version })
      sendStatus({ state: 'downloading', percent: 100, version: info.version })
      return
    }
    sendStatus({ state: 'downloaded', version: info.version, releaseUrl: getKnownReleaseUrl() })
  })

  autoUpdater.on('error', (err) => {
    const message = err?.message ?? 'Unknown error'
    // Native Squirrel listeners own staging errors; MacUpdater also re-emits them here.
    if (isAwaitingMacStaging()) {
      return
    }
    // Recover quit state before suppression guards; native failures may arrive asynchronously.
    if (handleQuitAndInstallFailure(err)) {
      return
    }
    if (isQuitAndInstallHandoffActive()) {
      return
    }
    // Fallback promise handlers may own this error; preserve their context.
    if (shouldSuppressMissingManifestPrereleaseFallbackEvent(message, err)) {
      return
    }
    if (!shouldHandleUpdaterErrorEvent()) {
      return
    }
    clearBackgroundCheckLaunchPending()
    resetMacInstallState()
    suppressMissingManifestPrereleaseFallbackPromiseFailure(message)
    const missingManifestFallback = consumeMissingManifestPrereleaseFallbackResult()
    const wasUserInitiated = missingManifestFallback?.userInitiated ?? getUserInitiatedCheck()
    setUserInitiatedCheck(false)
    if (getCurrentStatus().state === 'checking') {
      void sendCheckFailureStatus(message, wasUserInitiated || undefined, 'event', err)
      return
    }
    sendErrorStatus(message, wasUserInitiated || undefined)
    if (isLocalBuildCheck() || isPinnedBuildCheck()) {
      restoreReleaseUpdateSource()
    }
  })
}
