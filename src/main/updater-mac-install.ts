import { app, autoUpdater as nativeUpdater } from 'electron'
import type { UpdateStatus } from '../shared/update-status-types'
import {
  isMacUpdateInstallInFlight,
  markMacUpdateInstallInFlight
} from './mac-update-install-marker'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'

const MAC_INSTALL_READY_TIMEOUT_MS = 15000

export function registerMacUpdaterEvents({
  getCurrentStatus,
  hasInstallableDownloadedVersion,
  getPendingInstallVersion,
  getKnownReleaseUrl,
  requestRendererQuitAndInstall,
  shouldDeferMacQuitForInstall,
  sendStatus
}: {
  getCurrentStatus: () => UpdateStatus
  hasInstallableDownloadedVersion: () => boolean
  getPendingInstallVersion: () => string
  getKnownReleaseUrl: () => string | undefined
  requestRendererQuitAndInstall: () => void | Promise<void>
  shouldDeferMacQuitForInstall: () => boolean
  sendStatus: (status: UpdateStatus) => void
}): void {
  if (process.platform === 'darwin') {
    nativeUpdater.on('update-downloaded', () => {
      const hasInstallableVersion = hasInstallableDownloadedVersion()
      handleMacInstallerReady(hasInstallableVersion, requestRendererQuitAndInstall, () => {
        sendStatus({
          state: 'downloaded',
          version: getPendingInstallVersion(),
          releaseUrl: getKnownReleaseUrl()
        })
      })
    })
  }

  // Why will-quit and not the explicit install path only: autoInstallOnAppQuit is true on macOS
  // (getLinuxPackageType() returns 'non-root' off Linux), so Squirrel applies a staged update on
  // an ordinary quit too. A plain Cmd+Q therefore opens the same window in which reopening the
  // old version cancels the install, and that quit never runs performQuitAndInstall.
  // Why will-quit rather than before-quit: vetoes have already been resolved here, so the app is
  // genuinely on its way out and the marker cannot strand a launch for a quit that got abandoned.
  app.on('will-quit', () => {
    if (
      process.platform !== 'darwin' ||
      !isMacInstallerReady() ||
      // Explicit quitAndInstall already wrote the marker immediately before invoking native
      // handoff. Writing a second attempt here leaves an orphan marker that reports the same
      // install again on a later startup and can keep the launch gate active after settlement.
      isMacUpdateInstallInFlight()
    ) {
      return
    }
    const pendingVersion = getPendingInstallVersion()
    if (pendingVersion) {
      markMacUpdateInstallInFlight(pendingVersion)
    }
  })

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
}

/** Whether Squirrel.Mac has finished downloading the update from the localhost proxy. */
let squirrelReady = false
/** Remembers a user/app quit request that arrived before Squirrel.Mac had a
 * staged update ready to apply. Without this handoff, quitting during the
 * localhost-proxy phase exits back into the old app and the update is lost. */
let installRequestedAfterSquirrelReady = false
/** Prevents the updater-specific before-quit guard from re-blocking the
 * quitAndInstall-triggered shutdown that is supposed to apply the update. */
let quitAndInstallInFlight = false
/** Lets a timed-out quit attempt proceed exactly once so the app never gets
 * trapped open if Squirrel.Mac stops short of the native ready signal. */
let bypassMacInstallGuardOnce = false
let pendingInstallTimeout: ReturnType<typeof setTimeout> | null = null

function clearPendingInstallTimeout(): void {
  if (pendingInstallTimeout) {
    clearTimeout(pendingInstallTimeout)
    pendingInstallTimeout = null
  }
}

export function resetMacInstallState(): void {
  installRequestedAfterSquirrelReady = false
  quitAndInstallInFlight = false
  bypassMacInstallGuardOnce = false
  clearPendingInstallTimeout()
}

export function beginMacUpdateDownload(): void {
  resetMacInstallState()
  squirrelReady = false
}

export function markMacQuitAndInstallInFlight(): void {
  installRequestedAfterSquirrelReady = false
  quitAndInstallInFlight = true
  bypassMacInstallGuardOnce = false
  clearPendingInstallTimeout()
}

export function consumeMacInstallGuardBypass(): boolean {
  if (!bypassMacInstallGuardOnce) {
    return false
  }
  bypassMacInstallGuardOnce = false
  return true
}

export function isMacQuitAndInstallInFlight(): boolean {
  return quitAndInstallInFlight
}

export function isMacInstallerReady(): boolean {
  return squirrelReady
}

export function isWaitingForMacInstallerReadiness(
  currentStatus: UpdateStatus,
  hasNewerDownloadedVersion: boolean
): boolean {
  if (process.platform !== 'darwin' || squirrelReady || !hasNewerDownloadedVersion) {
    return false
  }

  // electron-updater fires 'update-downloaded' before Squirrel.Mac has staged
  // the update. Once we show 100% downloaded, treat quits as "install this as
  // soon as ShipIt is ready" instead of exiting back into the old version.
  return currentStatus.state === 'downloading' && currentStatus.percent === 100
}

export function deferMacQuitUntilInstallerReady(
  currentStatus: UpdateStatus,
  hasNewerDownloadedVersion: boolean,
  getPendingInstallVersion: () => string,
  sendStatus: (status: UpdateStatus) => void
): boolean {
  if (!isWaitingForMacInstallerReadiness(currentStatus, hasNewerDownloadedVersion)) {
    return false
  }

  installRequestedAfterSquirrelReady = true
  sendStatus({ state: 'downloading', percent: 100, version: getPendingInstallVersion() })

  if (pendingInstallTimeout) {
    return true
  }

  pendingInstallTimeout = setTimeout(() => {
    pendingInstallTimeout = null
    if (!installRequestedAfterSquirrelReady || quitAndInstallInFlight) {
      return
    }

    recordUpdaterLifecycle(
      'macos_install_guard_timeout',
      { timeoutMs: MAC_INSTALL_READY_TIMEOUT_MS },
      {
        level: 'warn',
        message: `macOS installer was not ready after ${MAC_INSTALL_READY_TIMEOUT_MS}ms; allowing quit without install`
      }
    )
    installRequestedAfterSquirrelReady = false
    // This is a safety valve. The updater path should wait for ShipIt so the
    // staged update can apply, but if the native ready signal never arrives we
    // must let the app close instead of trapping the user in a blocked quit.
    bypassMacInstallGuardOnce = true
    app.quit()
  }, MAC_INSTALL_READY_TIMEOUT_MS)

  return true
}

export function handleMacInstallerReady(
  hasNewerDownloadedVersion: boolean,
  onReadyToInstall: () => void | Promise<void>,
  onReadyToReportDownloaded: () => void
): void {
  squirrelReady = true
  clearPendingInstallTimeout()
  recordUpdaterLifecycle('macos_installer_ready', {
    deferredInstallRequested: installRequestedAfterSquirrelReady,
    hasNewerDownloadedVersion
  })

  if (installRequestedAfterSquirrelReady && hasNewerDownloadedVersion) {
    installRequestedAfterSquirrelReady = false
    // Why: a rejected renderer checkpoint must fall back to Ready to Install, not stick at 100%.
    onReadyToReportDownloaded()
    void Promise.resolve()
      .then(() => onReadyToInstall())
      .catch((error) => {
        recordUpdaterLifecycle(
          'macos_deferred_install_handoff_failed',
          { errorType: error instanceof Error ? error.name : typeof error },
          { level: 'warn', message: 'Deferred macOS install handoff failed' }
        )
      })
    return
  }

  if (hasNewerDownloadedVersion) {
    onReadyToReportDownloaded()
  }
}
