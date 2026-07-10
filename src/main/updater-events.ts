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
  // On macOS, electron-updater's MacUpdater downloads the ZIP from GitHub,
  // then serves it to Squirrel.Mac via a localhost proxy. The electron-updater
  // 'update-downloaded' event fires BEFORE Squirrel finishes its download.
  // Track Squirrel readiness so we don't show "ready to install" prematurely.
  if (process.platform === 'darwin') {
    nativeUpdater.on('update-downloaded', () => {
      const hasNewerVersion = hasNewerDownloadedVersion()
      handleMacInstallerReady(hasNewerVersion, performQuitAndInstall, () => {
        // If we were holding the 'downloaded' status, send it now — but only
        // when the staged version is actually newer than what's running.
        sendStatus({
          state: 'downloaded',
          version: getPendingInstallVersion(),
          releaseUrl: getKnownReleaseUrl()
        })
      })
    })
  }

  app.on('before-quit', (event) => {
    if (consumeMacInstallGuardBypass()) {
      recordUpdaterLifecycle('macos_before_quit_guard_bypassed')
      return
    }
    if (isMacQuitAndInstallInFlight()) {
      return
    }

    // On macOS the user can quit while Squirrel.Mac is still pulling the ZIP
    // from electron-updater's localhost proxy. If we let that quit finish,
    // autoInstallOnAppQuit has nothing staged to apply and the next launch
    // comes back on the old version. Hold the quit, then resume install when
    // nativeUpdater confirms ShipIt is actually ready.
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
        // Why: a fallback manifest at the current version is still the result of
        // a transient missing primary manifest, so keep the short retry cadence.
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

    // Why: fetching changelog in the main process avoids CORS issues that
    // would block a renderer-side fetch to onorca.dev, and ensures the
    // card can render immediately without an async loading gap.
    markUpdateAvailableEventPending(attemptId)
    void (async () => {
      try {
        const changelog = await fetchChangelog(info.version, app.getVersion()).catch(() => null)

        // Why: the handler is now async, so up to 5 seconds may pass during the
        // fetch. If another autoUpdater event (e.g., 'error') fired and updated
        // the attempt during that window, broadcasting 'available' here would
        // overwrite a more recent check. Guard on the attempt before state.
        if (!isActiveUpdateCheckAttempt(attemptId)) {
          return
        }
        if (getCurrentStatus().state !== 'checking' && getCurrentStatus().state !== 'idle') {
          return
        }

        // --- post-await side effects (only run if the guard passed) ---
        // Why: these must live AFTER the guard, not before the await. If the
        // fetch times out and a concurrent 'error' event advanced the status,
        // bailing out above avoids orphaned side effects — e.g., availableVersion
        // set without a matching 'available' broadcast, or a completed-check
        // timestamp persisted for a check that never showed a result.
        setAvailableVersion(info.version)
        setAvailableReleaseUrl(null)
        if (missingManifestFallback || publishingWindowLastGoodCheck) {
          // Why: offering a previous/last-good release is only a temporary
          // fallback; keep probing soon so users can move to the newest tag once
          // its platform manifest finishes publishing.
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
      // Why: the primary/newest release manifest/assets were missing, so a
      // last-good not-available result is still a transient release-transition
      // outcome and must not suppress the next retry for 24 hours.
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
    // Don't show the banner if the downloaded version isn't actually newer
    // than what's running. This catches the exact-same-version case as well
    // as stale cached updates from an older release.
    if (compareVersions(info.version, app.getVersion()) <= 0) {
      clearAvailableUpdateContext()
      sendStatus({ state: 'not-available' })
      return
    }
    const macInstallerReady = process.platform === 'darwin' ? isMacInstallerReady() : true
    recordUpdaterLifecycle('update_downloaded', { version: info.version, macInstallerReady })
    // On macOS, defer the 'downloaded' status until Squirrel.Mac has finished
    // processing the update via the localhost proxy. On other platforms,
    // the update is ready immediately after electron-updater downloads it.
    if (process.platform === 'darwin' && !macInstallerReady) {
      // Squirrel is still processing. Keep the UI at 100% downloaded so the
      // user sees the handoff instead of a misleading "ready to install".
      recordUpdaterLifecycle('macos_waiting_for_squirrel', { version: info.version })
      sendStatus({ state: 'downloading', percent: 100, version: info.version })
      return
    }
    sendStatus({ state: 'downloaded', version: info.version, releaseUrl: getKnownReleaseUrl() })
  })

  autoUpdater.on('error', (err) => {
    const message = err?.message ?? 'Unknown error'
    // Why: quitAndInstall reports the common "no staged update" failure through
    // this event (often sync on Win/Linux, async on macOS/spawn). Recover
    // quit-for-update flags before any suppression guard can early-return, but
    // only after native invoke and only when install is not yet committed.
    if (handleQuitAndInstallFailure()) {
      return
    }
    // Why: handoff still owns the process (cleanup, native in-flight, or
    // post-commit). Do not treat as check/download error or reset mac install.
    if (isQuitAndInstallHandoffActive()) {
      return
    }
    // Why: primary/fallback promise handlers may already own this failure; do
    // not let their delayed paired error event consume fallback context.
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
