/* eslint-disable max-lines */
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

const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const AUTO_UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000

type UpdaterHandlerContext = {
  autoUpdater: ElectronAutoUpdater
  clearBackgroundCheckLaunchPending: () => void
  clearActiveUpdateDownload: (version?: string) => void
  clearAvailableUpdateContext: () => void
  clearStagedUpdateContext: () => void
  consumeMissingManifestPrereleaseFallbackResult: () => { userInitiated: boolean } | null
  getActiveDownloadVersion: () => string | null
  getPublishingWindowLastGoodCheck: () => { lastGoodTag: string } | null
  getMissingManifestPrereleaseFallbackUserInitiated: () => boolean | null
  getCurrentStatus: () => UpdateStatus
  getKnownReleaseUrl: () => string | undefined
  getPendingInstallVersion: () => string
  getStagedUpdateVersion: () => string | null
  getUserInitiatedCheck: () => boolean
  hasNewerDownloadedVersion: () => boolean
  markMissingManifestPrereleaseFallbackChecking: () => void
  markStagedUpdate: (version: string, releaseUrl?: string) => void
  performQuitAndInstall: () => void
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
  startPendingReplacementDownload: () => boolean
  startAvailableUpdateDownload: () => void
  shouldAcceptDownloadedUpdate: (version: string) => boolean
  shouldSuppressMissingManifestPrereleaseFallbackEvent: (message: string, error: unknown) => boolean
  suppressMissingManifestPrereleaseFallbackPromiseFailure: (message: string) => void
  setAvailableReleaseUrl: (releaseUrl: string | null) => void
  setAvailableVersion: (version: string | null) => void
  setUserInitiatedCheck: (value: boolean) => void
}

function getActionableUpdateUserInitiated(status: UpdateStatus): boolean | undefined {
  if (
    status.state === 'checking' ||
    status.state === 'available' ||
    status.state === 'downloading' ||
    status.state === 'downloaded'
  ) {
    return status.userInitiated || undefined
  }
  return undefined
}

function shouldShowDownloadedForStagedUpdate(): boolean {
  return process.platform !== 'darwin' || isMacInstallerReady()
}

function shouldApplyAvailableResultAfterChangelog(status: UpdateStatus, version: string): boolean {
  if (status.state === 'checking' || status.state === 'idle') {
    return true
  }
  if (
    status.state === 'available' ||
    status.state === 'downloading' ||
    status.state === 'downloaded'
  ) {
    return compareVersions(status.version, version) < 0
  }
  return false
}

export function registerAutoUpdaterHandlers({
  autoUpdater,
  clearBackgroundCheckLaunchPending,
  clearActiveUpdateDownload,
  clearAvailableUpdateContext,
  clearStagedUpdateContext,
  consumeMissingManifestPrereleaseFallbackResult,
  getActiveDownloadVersion,
  getPublishingWindowLastGoodCheck,
  getMissingManifestPrereleaseFallbackUserInitiated,
  getCurrentStatus,
  getKnownReleaseUrl,
  getPendingInstallVersion,
  getStagedUpdateVersion,
  getUserInitiatedCheck,
  hasNewerDownloadedVersion,
  markMissingManifestPrereleaseFallbackChecking,
  markStagedUpdate,
  performQuitAndInstall,
  recordCompletedUpdateCheck,
  sendCheckFailureStatus,
  sendErrorStatus,
  sendStatus,
  scheduleAutomaticUpdateCheck,
  startPendingReplacementDownload,
  startAvailableUpdateDownload,
  shouldAcceptDownloadedUpdate,
  shouldSuppressMissingManifestPrereleaseFallbackEvent,
  suppressMissingManifestPrereleaseFallbackPromiseFailure,
  setAvailableReleaseUrl,
  setAvailableVersion,
  setUserInitiatedCheck
}: UpdaterHandlerContext): void {
  let macNativeReadinessPendingVersion: string | null = null

  const sendStagedUpdateStatus = (version: string, userInitiated: boolean): void => {
    if (!shouldShowDownloadedForStagedUpdate()) {
      // Why: on macOS the electron-updater artifact can be staged before ShipIt
      // has finished pulling it from the localhost proxy.
      sendStatus({
        state: 'downloading',
        percent: 100,
        version,
        ...(userInitiated ? { userInitiated: true } : {})
      })
      return
    }
    sendStatus({
      state: 'downloaded',
      version,
      releaseUrl: getKnownReleaseUrl(),
      ...(userInitiated ? { userInitiated: true } : {})
    })
  }

  // On macOS, electron-updater's MacUpdater downloads the ZIP from GitHub,
  // then serves it to Squirrel.Mac via a localhost proxy. The electron-updater
  // 'update-downloaded' event fires BEFORE Squirrel finishes its download.
  // Track Squirrel readiness so we don't show "ready to install" prematurely.
  if (process.platform === 'darwin') {
    nativeUpdater.on('update-downloaded', () => {
      const readyVersion = macNativeReadinessPendingVersion
      macNativeReadinessPendingVersion = null

      if (!readyVersion && !hasNewerDownloadedVersion()) {
        return
      }
      const shouldUseNativeReadiness =
        !readyVersion || (getStagedUpdateVersion() === readyVersion && hasNewerDownloadedVersion())
      handleMacInstallerReady(shouldUseNativeReadiness, performQuitAndInstall, () => {
        // If we were holding the 'downloaded' status, send it now — but only
        // when the staged version is actually newer than what's running.
        sendStatus({
          state: 'downloaded',
          version: getPendingInstallVersion(),
          releaseUrl: getKnownReleaseUrl(),
          ...(getActionableUpdateUserInitiated(getCurrentStatus()) ? { userInitiated: true } : {})
        })
      })
      startAvailableUpdateDownload()
    })
  }

  app.on('before-quit', (event) => {
    if (consumeMacInstallGuardBypass() || isMacQuitAndInstallInFlight()) {
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
      event.preventDefault()
    }
  })

  autoUpdater.on('checking-for-update', () => {
    clearBackgroundCheckLaunchPending()
    resetMacInstallState()
    clearAvailableUpdateContext()
    markMissingManifestPrereleaseFallbackChecking()
    const fallbackUserInitiated = getMissingManifestPrereleaseFallbackUserInitiated()
    const wasUserInitiated = fallbackUserInitiated ?? getUserInitiatedCheck()
    sendStatus({ state: 'checking', userInitiated: wasUserInitiated || undefined })
  })

  autoUpdater.on('update-available', (info) => {
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

    const stagedVersion = getStagedUpdateVersion()
    if (stagedVersion && compareVersions(info.version, stagedVersion) <= 0) {
      // Why: a freshness check should offer an already-staged update only when
      // the feed does not point at a newer version.
      clearAvailableUpdateContext()
      if (missingManifestFallback || publishingWindowLastGoodCheck) {
        scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      } else {
        recordCompletedUpdateCheck()
        if (!wasUserInitiated) {
          scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
        }
      }
      sendStagedUpdateStatus(stagedVersion, wasUserInitiated)
      return
    }

    // Why: fetching changelog in the main process avoids CORS issues that
    // would block a renderer-side fetch to onorca.dev, and ensures the
    // card can render immediately without an async loading gap.
    void (async () => {
      const changelog = await fetchChangelog(info.version, app.getVersion()).catch(() => null)

      // Why: the handler is now async, so up to 5 seconds may pass during the
      // fetch. If another autoUpdater event (e.g., 'error') fired and updated
      // currentStatus during that window, broadcasting 'available' here would
      // overwrite a more recent status. Guard against this by checking that the
      // state hasn't advanced past the point where 'available' makes sense.
      if (!shouldApplyAvailableResultAfterChangelog(getCurrentStatus(), info.version)) {
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

      sendStatus({
        state: 'available',
        version: info.version,
        ...(wasUserInitiated ? { userInitiated: true } : {}),
        changelog
      })
      if (process.platform === 'darwin' && macNativeReadinessPendingVersion) {
        // Why: Squirrel.Mac's native ready event has no version payload. Wait
        // for the prior handoff before starting a replacement download.
        return
      }
      startAvailableUpdateDownload()
    })()
  })

  autoUpdater.on('update-not-available', () => {
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
    const stagedVersion = getStagedUpdateVersion()
    if (stagedVersion && compareVersions(stagedVersion, app.getVersion()) > 0) {
      // Why: "not available" means no newer feed result, not that a previously
      // staged update disappeared. Keep the restart action available.
      sendStagedUpdateStatus(stagedVersion, wasUserInitiated)
      return
    }
    sendStatus({ state: 'not-available', userInitiated: wasUserInitiated || undefined })
  })

  autoUpdater.on('download-progress', (progress) => {
    clearBackgroundCheckLaunchPending()
    const userInitiated = getActionableUpdateUserInitiated(getCurrentStatus())
    sendStatus({
      state: 'downloading',
      percent: Math.round(progress.percent),
      version: getActiveDownloadVersion() ?? getPendingInstallVersion(),
      ...(userInitiated ? { userInitiated: true } : {})
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    clearBackgroundCheckLaunchPending()
    if (!shouldAcceptDownloadedUpdate(info.version)) {
      clearActiveUpdateDownload(info.version)
      startPendingReplacementDownload()
      return
    }
    // Don't show the banner if the downloaded version isn't actually newer
    // than what's running. This catches the exact-same-version case as well
    // as stale cached updates from an older release.
    if (compareVersions(info.version, app.getVersion()) <= 0) {
      clearAvailableUpdateContext()
      clearStagedUpdateContext()
      clearActiveUpdateDownload(info.version)
      sendStatus({ state: 'not-available' })
      return
    }
    markStagedUpdate(info.version, getKnownReleaseUrl())
    clearActiveUpdateDownload(info.version)
    // On macOS, defer the 'downloaded' status until Squirrel.Mac has finished
    // processing the update via the localhost proxy. On other platforms,
    // the update is ready immediately after electron-updater downloads it.
    if (process.platform === 'darwin' && !isMacInstallerReady()) {
      macNativeReadinessPendingVersion = info.version
      // Squirrel is still processing. Keep the UI at 100% downloaded so the
      // user sees the handoff instead of a misleading "ready to install".
      sendStatus({
        state: 'downloading',
        percent: 100,
        version: info.version,
        ...(getActionableUpdateUserInitiated(getCurrentStatus()) ? { userInitiated: true } : {})
      })
      return
    }
    sendStatus({
      state: 'downloaded',
      version: info.version,
      releaseUrl: getKnownReleaseUrl(),
      ...(getActionableUpdateUserInitiated(getCurrentStatus()) ? { userInitiated: true } : {})
    })
  })

  autoUpdater.on('error', (err) => {
    const message = err?.message ?? 'Unknown error'
    // Why: primary/fallback promise handlers may already own this failure; do
    // not let their delayed paired error event consume fallback context.
    if (shouldSuppressMissingManifestPrereleaseFallbackEvent(message, err)) {
      return
    }
    const statusAtError = getCurrentStatus()
    const activeDownloadVersionAtError = getActiveDownloadVersion()
    clearBackgroundCheckLaunchPending()
    if (activeDownloadVersionAtError) {
      clearActiveUpdateDownload(activeDownloadVersionAtError)
    } else if (statusAtError.state !== 'checking') {
      clearActiveUpdateDownload()
    }
    resetMacInstallState()
    suppressMissingManifestPrereleaseFallbackPromiseFailure(message)
    const missingManifestFallback = consumeMissingManifestPrereleaseFallbackResult()
    const wasUserInitiated =
      (missingManifestFallback?.userInitiated ?? getUserInitiatedCheck()) ||
      getActionableUpdateUserInitiated(getCurrentStatus())
    setUserInitiatedCheck(false)
    if (statusAtError.state === 'checking' && !activeDownloadVersionAtError) {
      void sendCheckFailureStatus(message, wasUserInitiated || undefined, 'event', err)
      return
    }
    if (startPendingReplacementDownload()) {
      return
    }
    sendErrorStatus(message, wasUserInitiated || undefined)
  })
}
