import { app, autoUpdater as nativeUpdater } from 'electron'
import { autoUpdater } from 'electron-updater'
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

type UpdaterHandlerContext = {
  clearAvailableUpdateContext: () => void
  getCurrentStatus: () => UpdateStatus
  getKnownReleaseUrl: () => string | undefined
  getPendingInstallVersion: () => string
  getUserInitiatedCheck: () => boolean
  hasNewerDownloadedVersion: () => boolean
  performQuitAndInstall: () => void
  recordCompletedUpdateCheck: () => void
  sendCheckFailureStatus: (message: string, userInitiated?: boolean) => Promise<void>
  sendErrorStatus: (message: string, userInitiated?: boolean) => void
  sendStatus: (status: UpdateStatus) => void
  scheduleAutomaticUpdateCheck: (delayMs: number) => void
  setAvailableReleaseUrl: (releaseUrl: string | null) => void
  setAvailableVersion: (version: string | null) => void
  setUserInitiatedCheck: (value: boolean) => void
}

export function registerAutoUpdaterHandlers({
  clearAvailableUpdateContext,
  getCurrentStatus,
  getKnownReleaseUrl,
  getPendingInstallVersion,
  getUserInitiatedCheck,
  hasNewerDownloadedVersion,
  performQuitAndInstall,
  recordCompletedUpdateCheck,
  sendCheckFailureStatus,
  sendErrorStatus,
  sendStatus,
  scheduleAutomaticUpdateCheck,
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
      handleMacInstallerReady(hasNewerDownloadedVersion(), performQuitAndInstall, () => {
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
    resetMacInstallState()
    clearAvailableUpdateContext()
    sendStatus({ state: 'checking', userInitiated: getUserInitiatedCheck() || undefined })
  })

  autoUpdater.on('update-available', (info) => {
    const wasUserInitiated = getUserInitiatedCheck()
    setUserInitiatedCheck(false)
    // Guard against showing an update that isn't actually newer than what's running.
    // With allowPrerelease enabled, electron-updater may report the current or
    // even an older version as "available". Use semver comparison so we never
    // prompt the user to "update" to a version they already have.
    if (compareVersions(info.version, app.getVersion()) <= 0) {
      clearAvailableUpdateContext()
      sendStatus({ state: 'not-available', userInitiated: wasUserInitiated || undefined })
      return
    }
    setAvailableVersion(info.version)
    setAvailableReleaseUrl(null)
    recordCompletedUpdateCheck()
    if (!wasUserInitiated) {
      scheduleAutomaticUpdateCheck(36 * 60 * 60 * 1000)
    }
    sendStatus({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    resetMacInstallState()
    const wasUserInitiated = getUserInitiatedCheck()
    setUserInitiatedCheck(false)
    clearAvailableUpdateContext()
    recordCompletedUpdateCheck()
    if (!wasUserInitiated) {
      scheduleAutomaticUpdateCheck(36 * 60 * 60 * 1000)
    }
    sendStatus({ state: 'not-available', userInitiated: wasUserInitiated || undefined })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus({
      state: 'downloading',
      percent: Math.round(progress.percent),
      version: getPendingInstallVersion()
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    // Don't show the banner if the downloaded version isn't actually newer
    // than what's running. This catches the exact-same-version case as well
    // as stale cached updates from an older release.
    if (compareVersions(info.version, app.getVersion()) <= 0) {
      clearAvailableUpdateContext()
      sendStatus({ state: 'not-available' })
      return
    }
    // On macOS, defer the 'downloaded' status until Squirrel.Mac has finished
    // processing the update via the localhost proxy. On other platforms,
    // the update is ready immediately after electron-updater downloads it.
    if (process.platform === 'darwin' && !isMacInstallerReady()) {
      // Squirrel is still processing. Keep the UI at 100% downloaded so the
      // user sees the handoff instead of a misleading "ready to install".
      sendStatus({ state: 'downloading', percent: 100, version: info.version })
      return
    }
    sendStatus({ state: 'downloaded', version: info.version, releaseUrl: getKnownReleaseUrl() })
  })

  autoUpdater.on('error', (err) => {
    resetMacInstallState()
    const wasUserInitiated = getUserInitiatedCheck()
    setUserInitiatedCheck(false)
    const message = err?.message ?? 'Unknown error'
    if (getCurrentStatus().state === 'checking') {
      void sendCheckFailureStatus(message, wasUserInitiated || undefined)
      return
    }
    sendErrorStatus(message, wasUserInitiated || undefined)
  })
}
