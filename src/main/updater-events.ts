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
  handleQuitAndInstallFailure: () => boolean
  isQuitAndInstallHandoffActive: () => boolean
  hasNewerDownloadedVersion: () => boolean
  shouldHandleUpdaterErrorEvent: () => boolean
  clearUpdateAvailableEventPending: (attemptId: number | null) => void
  isActiveUpdateCheckAttempt: (attemptId: number) => boolean
  markUpdateCheckEventAttempt: () => boolean
  markUpdateAvailableEventPending: (attemptId: number | null) => void
  markMissingManifestPrereleaseFallbackChecking: () => void
  performQuitAndInstall: () => void | Promise<void>
  shouldDeferMacQuitForInstall: () => boolean
  recordCompletedUpdateCheck: () => void
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
  hasNewerDownloadedVersion,
  shouldHandleUpdaterErrorEvent,
  clearUpdateAvailableEventPending,
  isActiveUpdateCheckAttempt,
  markUpdateCheckEventAttempt,
  markUpdateAvailableEventPending,
  markMissingManifestPrereleaseFallbackChecking,
  performQuitAndInstall,
  shouldDeferMacQuitForInstall,
  recordCompletedUpdateCheck,
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
      const hasNewerVersion = hasNewerDownloadedVersion()
      handleMacInstallerReady(hasNewerVersion, performQuitAndInstall, () => {
        // Send the held 'downloaded' status now, only if the staged version is newer.
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
        hasNewerDownloadedVersion(),
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

    // Guard: don't show an update that isn't actually newer than what's running.
    if (compareVersions(info.version, app.getVersion()) <= 0) {
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

    // Why: fetch the changelog in main to avoid renderer-side CORS on onorca.dev.
    markUpdateAvailableEventPending(attemptId)
    void (async () => {
      try {
        const changelog = await fetchChangelog(info.version, app.getVersion()).catch(() => null)

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
        if (missingManifestFallback || publishingWindowLastGoodCheck) {
          // Why: last-good release is a temporary fallback; keep probing so users can move to the newest tag once it publishes.
          scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
        } else {
          recordCompletedUpdateCheck()
          if (!wasUserInitiated) {
            scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
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
    const missingManifestFallback = consumeMissingManifestPrereleaseFallbackResult()
    const publishingWindowLastGoodCheck = getPublishingWindowLastGoodCheck()
    const wasUserInitiated = missingManifestFallback?.userInitiated ?? getUserInitiatedCheck()
    setUserInitiatedCheck(false)
    clearAvailableUpdateContext()
    if (missingManifestFallback || publishingWindowLastGoodCheck) {
      // Why: last-good not-available is a transient release-transition outcome; keep the short retry, don't suppress for 24h.
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
    } else {
      recordCompletedUpdateCheck()
      if (!wasUserInitiated) {
        scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
      }
    }
    sendStatus({ state: 'not-available', userInitiated: wasUserInitiated || undefined })
  })

  autoUpdater.on('download-progress', (progress) => {
    clearBackgroundCheckLaunchPending()
    sendStatus({
      state: 'downloading',
      percent: Math.round(progress.percent),
      version: getPendingInstallVersion()
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    clearBackgroundCheckLaunchPending()
    // Skip the banner for non-newer versions (same-version or stale cached updates).
    if (compareVersions(info.version, app.getVersion()) <= 0) {
      clearAvailableUpdateContext()
      sendStatus({ state: 'not-available' })
      return
    }
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
    if (handleQuitAndInstallFailure()) {
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
  })
}
