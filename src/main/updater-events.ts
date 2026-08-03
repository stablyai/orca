import { app, autoUpdater as nativeUpdater } from 'electron'
import type { UpdateStatus } from '../shared/types'
import {
  consumeMacInstallGuardBypass,
  deferMacQuitUntilInstallerReady,
  handleMacInstallerReady,
  isMacInstallerReady,
  isMacQuitAndInstallInFlight,
  resetMacInstallState
} from './updater-mac-install'
import { compareVersions } from './updater-fallback'
import { fetchChangelog } from './updater-changelog'
import type { ElectronAutoUpdater } from './electron-updater-loader'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'
import {
  captureLinuxPackageArtifact,
  clearTrackedLinuxPackageArtifact,
  clearTrackedLinuxPackageArtifactForOtherVersion
} from './linux-package-update-recovery'

const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const AUTO_UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000

type UpdaterHandlerContext = {
  autoUpdater: ElectronAutoUpdater
  clearBackgroundCheckLaunchPending: () => void
  clearAvailableUpdateContext: () => void
  consumeMissingManifestPrereleaseFallbackResult: () => { userInitiated: boolean } | null
  getPublishingWindowLastGoodCheck: () => { lastGoodTag: string } | null
  getMissingManifestPrereleaseFallbackUserInitiated: () => boolean | null
  getCurrentStatus: () => UpdateStatus
  getActiveUpdateCheckEventAttemptId: () => number | null
  getKnownReleaseUrl: () => string | undefined
  getPendingInstallVersion: () => string
  getUserInitiatedCheck: () => boolean
  handleQuitAndInstallFailure: (error?: unknown) => boolean
  isQuitAndInstallHandoffActive: () => boolean
  hasInstallableDownloadedVersion: () => boolean
  isLocalBuildCheck: () => boolean
  isPinnedBuildCheck: () => boolean
  shouldHandleUpdaterErrorEvent: () => boolean
  clearUpdateAvailableEventPending: (attemptId: number | null) => void
  isActiveUpdateCheckAttempt: (attemptId: number) => boolean
  markUpdateCheckEventAttempt: () => boolean
  markUpdateAvailableEventPending: (attemptId: number | null) => void
  markMissingManifestPrereleaseFallbackChecking: () => void
  performQuitAndInstall: () => void | Promise<void>
  shouldDeferMacQuitForInstall: () => boolean
  recordCompletedUpdateCheck: () => void
  restoreReleaseUpdateSource: () => void
  sendCheckFailureStatus: (
    message: string,
    userInitiated?: boolean,
    source?: 'event' | 'promise' | 'fallback-promise',
    sourceError?: unknown
  ) => Promise<void>
  sendErrorStatus: (message: string, userInitiated?: boolean) => void
  sendStatus: (status: UpdateStatus) => void
  scheduleAutomaticUpdateCheck: (delayMs: number) => void
  shouldSuppressMissingManifestPrereleaseFallbackEvent: (message: string, error: unknown) => boolean
  suppressMissingManifestPrereleaseFallbackPromiseFailure: (message: string) => void
  setAvailableReleaseUrl: (releaseUrl: string | null) => void
  setAvailableVersion: (version: string | null) => void
  setUserInitiatedCheck: (value: boolean) => void
}

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
  // Why: electron-updater fires 'update-downloaded' before Squirrel.Mac finishes; track readiness to avoid a premature "ready".
  if (process.platform === 'darwin') {
    nativeUpdater.on('update-downloaded', () => {
      const hasInstallableVersion = hasInstallableDownloadedVersion()
      handleMacInstallerReady(hasInstallableVersion, performQuitAndInstall, () => {
        // Send the held status only while its staged build is still installable.
        sendStatus({
          state: 'downloaded',
          version: getPendingInstallVersion(),
          releaseUrl: getKnownReleaseUrl()
        })
      })
    })
  }

  app.on('before-quit', (event) => {
    if (!shouldDeferMacQuitForInstall()) {
      return
    }
    if (consumeMacInstallGuardBypass()) {
      recordUpdaterLifecycle('macos_before_quit_guard_bypassed')
      return
    }
    if (isMacQuitAndInstallInFlight()) {
      return
    }

    // Why: quitting before Squirrel.Mac finishes staging leaves nothing to install; hold the quit until it's ready.
    if (
      deferMacQuitUntilInstallerReady(
        getCurrentStatus(),
        hasInstallableDownloadedVersion(),
        getPendingInstallVersion,
        sendStatus
      )
    ) {
      recordUpdaterLifecycle('macos_before_quit_deferred', {
        version: getPendingInstallVersion()
      })
      event.preventDefault()
    }
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
    // --- synchronous preamble (runs before any await) ---
    const missingManifestFallback = consumeMissingManifestPrereleaseFallbackResult()
    const publishingWindowLastGoodCheck = getPublishingWindowLastGoodCheck()
    const wasUserInitiated = missingManifestFallback?.userInitiated ?? getUserInitiatedCheck()
    setUserInitiatedCheck(false)

    // Release checks remain newer-only; validated local builds and pinned dev jumps may intentionally downgrade.
    if (
      !isLocalBuildCheck() &&
      !isPinnedBuildCheck() &&
      compareVersions(info.version, app.getVersion()) <= 0
    ) {
      clearAvailableUpdateContext()
      if (missingManifestFallback || publishingWindowLastGoodCheck) {
        // Why: a current-version fallback manifest means the primary is transiently missing; keep the short retry cadence.
        scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      } else {
        recordCompletedUpdateCheck()
        if (!wasUserInitiated) {
          scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
        }
      }
      sendStatus({ state: 'not-available', userInitiated: wasUserInitiated || undefined })
      return
    }

    // Why: only a genuinely newer offer supersedes the retained package; a publishing-window blip that
    // momentarily resolves an older tag must not destroy a still-valid recovery path.
    clearTrackedLinuxPackageArtifactForOtherVersion(info.version)

    // Why: fetch the changelog in main to avoid renderer-side CORS on onorca.dev.
    markUpdateAvailableEventPending(attemptId)
    void (async () => {
      try {
        const changelog =
          isLocalBuildCheck() || isPinnedBuildCheck()
            ? null
            : await fetchChangelog(info.version, app.getVersion()).catch(() => null)

        // Why: async fetch may take seconds; bail if a newer event superseded this attempt to avoid a stale 'available' broadcast.
        if (!isActiveUpdateCheckAttempt(attemptId)) {
          return
        }
        if (getCurrentStatus().state !== 'checking' && getCurrentStatus().state !== 'idle') {
          return
        }

        // Why: side effects must run after the guard so a concurrent 'error' during the fetch can't leave orphaned state.
        setAvailableVersion(info.version)
        setAvailableReleaseUrl(null)
        // Why: a pinned dev jump is not a release check. Letting it call
        // recordCompletedUpdateCheck() would persist lastUpdateCheckAt and
        // suppress the next real background check for a full day.
        if (!isLocalBuildCheck() && !isPinnedBuildCheck()) {
          if (missingManifestFallback || publishingWindowLastGoodCheck) {
            // Why: last-good release is a temporary fallback; keep probing so users can move to the newest tag once it publishes.
            scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
          } else {
            recordCompletedUpdateCheck()
            if (!wasUserInitiated) {
              scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
            }
          }
        }

        sendStatus({ state: 'available', version: info.version, changelog })
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
    clearTrackedLinuxPackageArtifact()
    const missingManifestFallback = consumeMissingManifestPrereleaseFallbackResult()
    const publishingWindowLastGoodCheck = getPublishingWindowLastGoodCheck()
    const wasUserInitiated = missingManifestFallback?.userInitiated ?? getUserInitiatedCheck()
    const localBuildCheck = isLocalBuildCheck()
    // Why: an unpinned outcome must hand the feed back, else the pin blocks every
    // later background check for the process lifetime.
    const pinnedBuildCheck = isPinnedBuildCheck()
    setUserInitiatedCheck(false)
    clearAvailableUpdateContext()
    if (!localBuildCheck && !pinnedBuildCheck) {
      if (missingManifestFallback || publishingWindowLastGoodCheck) {
        // Why: last-good not-available is a transient release-transition outcome; keep the short retry, don't suppress for 24h.
        scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      } else {
        recordCompletedUpdateCheck()
        if (!wasUserInitiated) {
          scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
        }
      }
    }
    sendStatus({ state: 'not-available', userInitiated: wasUserInitiated || undefined })
    if (localBuildCheck || pinnedBuildCheck) {
      restoreReleaseUpdateSource()
    }
  })

  autoUpdater.on('download-progress', (progress) => {
    clearBackgroundCheckLaunchPending()
    const version = getPendingInstallVersion()
    clearTrackedLinuxPackageArtifactForOtherVersion(version)
    sendStatus({
      state: 'downloading',
      percent: Math.round(progress.percent),
      version
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    clearBackgroundCheckLaunchPending()
    // Release downloads remain newer-only; the local source was validated before checking, and a pinned jump is explicit.
    if (
      !isLocalBuildCheck() &&
      !isPinnedBuildCheck() &&
      compareVersions(info.version, app.getVersion()) <= 0
    ) {
      clearAvailableUpdateContext()
      clearTrackedLinuxPackageArtifact()
      sendStatus({ state: 'not-available' })
      return
    }
    // Why: retain the verified artifact now — the 'error' event after a failed install no longer carries it.
    captureLinuxPackageArtifact(info)
    const macInstallerReady = process.platform === 'darwin' ? isMacInstallerReady() : true
    recordUpdaterLifecycle('update_downloaded', { version: info.version, macInstallerReady })
    // On macOS, defer 'downloaded' until Squirrel.Mac finishes processing; other platforms are ready immediately.
    if (process.platform === 'darwin' && !macInstallerReady) {
      // Keep the UI at 100% downloaded while Squirrel processes, to avoid a premature "ready to install".
      recordUpdaterLifecycle('macos_waiting_for_squirrel', { version: info.version })
      sendStatus({ state: 'downloading', percent: 100, version: info.version })
      return
    }
    sendStatus({ state: 'downloaded', version: info.version, releaseUrl: getKnownReleaseUrl() })
  })

  autoUpdater.on('error', (err) => {
    const message = err?.message ?? 'Unknown error'
    // Why: quitAndInstall reports "no staged update" via this error event (async on macOS); recover quit flags before suppression guards run.
    if (handleQuitAndInstallFailure(err)) {
      return
    }
    // Why: handoff still owns the process; don't treat as a check/download error.
    if (isQuitAndInstallHandoffActive()) {
      return
    }
    // Why: fallback promise handlers may already own this failure; don't consume fallback context here.
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
