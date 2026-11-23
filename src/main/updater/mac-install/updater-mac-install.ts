import { app, autoUpdater as nativeUpdater } from 'electron'
import { homedir } from 'node:os'
import type { UpdateStatus } from '../../../shared/updater/update-status-types'
import { macCoordinationRoot } from '../../../shared/remote-runtime/serve-supervisor/serve-bundle-coordination'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { commitServeSupervisorParkOnQuit } from '../lifecycle/serve-supervisor-install-park'

const MAC_INSTALL_READY_TIMEOUT_MS = 15000

export function registerMacUpdaterEvents({
  getCurrentStatus,
  hasInstallableDownloadedVersion,
  getPendingInstallVersion,
  getKnownReleaseUrl,
  performQuitAndInstall,
  commitStagedMacInstall,
  finishMacStaging,
  failMacStaging,
  shouldDeferMacQuitForInstall,
  sendStatus
}: {
  getCurrentStatus: () => UpdateStatus
  hasInstallableDownloadedVersion: () => boolean
  getPendingInstallVersion: () => string
  getKnownReleaseUrl: () => string | undefined
  performQuitAndInstall: () => void | Promise<void>
  commitStagedMacInstall: () => void
  finishMacStaging: () => string | null
  failMacStaging: (error: unknown) => void
  shouldDeferMacQuitForInstall: () => boolean
  sendStatus: (status: UpdateStatus) => void
}): void {
  if (process.platform === 'darwin') {
    nativeUpdater.on('error', failMacStaging)
    nativeUpdater.on('update-downloaded', () => {
      // Interactive staging owns the feed until a native result, even after the UI times out.
      const stagingVersion = finishMacStaging()
      if (shouldDeferMacQuitForInstall() && stagingVersion === null) {
        return
      }
      // Commit before MacUpdater's later listener calls app.quit.
      commitStagedMacInstall()
      const hasInstallableVersion = hasInstallableDownloadedVersion()
      handleMacInstallerReady(stagingVersion, hasInstallableVersion, performQuitAndInstall, () => {
        sendStatus({
          state: 'downloaded',
          version: stagingVersion ?? getPendingInstallVersion(),
          releaseUrl: getKnownReleaseUrl()
        })
      })
    })
    // will-quit is past every quit veto; prepend so quit teardown sees the commit it must wait for.
    // Squirrel installs whatever it staged once this process exits.
    app.prependListener('will-quit', () => {
      if (shouldDeferMacQuitForInstall() && isMacInstallerReady()) {
        void commitServeSupervisorParkOnQuit(process.execPath, macCoordinationRoot(homedir()))
      }
    })
  }

  // Veto before other listeners start shutting down services.
  app.prependListener('before-quit', (event) => {
    if (!shouldDeferMacQuitForInstall()) {
      return
    }
    // A second quit must not tear down services during install preflight.
    if (macInstallPreflightInProgress) {
      event.preventDefault()
      return
    }
    if (shouldBypassMacInstallGuard()) {
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
        sendStatus,
        'quit'
      )
    ) {
      recordUpdaterLifecycle('macos_before_quit_deferred', {
        version: getPendingInstallVersion()
      })
      event.preventDefault()
    }
  })
}

let macInstallerReady: { version: string | null } | null = null
let macInstallPreflightInProgress = false

export function setMacInstallPreflightInProgress(value: boolean): void {
  macInstallPreflightInProgress = value
  if (value) {
    bypassMacInstallGuardUntilNextAttempt = false
  }
}
// Defer early quit/install requests until Squirrel stages the update, or the update is lost.
let requestedActionAfterSquirrelReady: 'quit' | 'install' | null = null
// Do not re-block the shutdown triggered by quitAndInstall.
let quitAndInstallInFlight = false
// Timeout recovery must allow both quit passes.
let bypassMacInstallGuardUntilNextAttempt = false
let pendingInstallTimeout: ReturnType<typeof setTimeout> | null = null

function clearPendingInstallTimeout(): void {
  if (pendingInstallTimeout) {
    clearTimeout(pendingInstallTimeout)
    pendingInstallTimeout = null
  }
}

export function resetMacInstallState(): void {
  macInstallPreflightInProgress = false
  requestedActionAfterSquirrelReady = null
  quitAndInstallInFlight = false
  bypassMacInstallGuardUntilNextAttempt = false
  clearPendingInstallTimeout()
}

export function beginMacUpdateDownload(): void {
  resetMacInstallState()
  macInstallerReady = null
}

export function markMacQuitAndInstallInFlight(): void {
  requestedActionAfterSquirrelReady = null
  quitAndInstallInFlight = true
  bypassMacInstallGuardUntilNextAttempt = false
  clearPendingInstallTimeout()
}

function shouldBypassMacInstallGuard(): boolean {
  return bypassMacInstallGuardUntilNextAttempt
}

export function isMacInstallRequested(): boolean {
  return requestedActionAfterSquirrelReady === 'install'
}

export function isMacQuitAndInstallInFlight(): boolean {
  return quitAndInstallInFlight
}

export function isMacInstallerReady(version?: string): boolean {
  return (
    macInstallerReady !== null && (version === undefined || version === macInstallerReady.version)
  )
}

export function isWaitingForMacInstallerReadiness(
  currentStatus: UpdateStatus,
  hasNewerDownloadedVersion: boolean
): boolean {
  if (process.platform !== 'darwin' || isMacInstallerReady() || !hasNewerDownloadedVersion) {
    return false
  }

  // electron-updater reports completion before Squirrel stages; hold quits until native readiness.
  return currentStatus.state === 'downloading' && currentStatus.percent === 100
}

export function deferMacQuitUntilInstallerReady(
  currentStatus: UpdateStatus,
  hasNewerDownloadedVersion: boolean,
  getPendingInstallVersion: () => string,
  sendStatus: (status: UpdateStatus) => void,
  intent: 'quit' | 'install' = 'install'
): boolean {
  if (!isWaitingForMacInstallerReadiness(currentStatus, hasNewerDownloadedVersion)) {
    return false
  }

  if (intent === 'install') {
    bypassMacInstallGuardUntilNextAttempt = false
  }
  if (intent === 'install' || requestedActionAfterSquirrelReady !== 'install') {
    requestedActionAfterSquirrelReady = intent
  }
  sendStatus({ state: 'downloading', percent: 100, version: getPendingInstallVersion() })

  if (pendingInstallTimeout) {
    return true
  }

  pendingInstallTimeout = setTimeout(() => {
    pendingInstallTimeout = null
    if (!requestedActionAfterSquirrelReady || quitAndInstallInFlight) {
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
    requestedActionAfterSquirrelReady = null
    // Native readiness may never arrive; let the user quit rather than trapping the app.
    bypassMacInstallGuardUntilNextAttempt = true
    app.quit()
  }, MAC_INSTALL_READY_TIMEOUT_MS)

  return true
}

function handleMacInstallerReady(
  version: string | null,
  hasNewerDownloadedVersion: boolean,
  onReadyToInstall: () => void | Promise<void>,
  onReadyToReportDownloaded: () => void
): void {
  macInstallerReady = { version }
  clearPendingInstallTimeout()
  recordUpdaterLifecycle('macos_installer_ready', {
    deferredInstallRequested: requestedActionAfterSquirrelReady === 'install',
    deferredQuitRequested: requestedActionAfterSquirrelReady === 'quit',
    hasNewerDownloadedVersion
  })

  if (requestedActionAfterSquirrelReady === 'quit') {
    requestedActionAfterSquirrelReady = null
    app.quit()
    return
  }

  if (requestedActionAfterSquirrelReady === 'install' && hasNewerDownloadedVersion) {
    setMacInstallPreflightInProgress(true)
    void Promise.resolve()
      .then(() => onReadyToInstall())
      .catch((error) => {
        requestedActionAfterSquirrelReady = null
        setMacInstallPreflightInProgress(false)
        recordUpdaterLifecycle(
          'macos_deferred_install_handoff_failed',
          { errorType: error instanceof Error ? error.name : typeof error },
          { level: 'warn', message: 'Deferred macOS install handoff failed' }
        )
      })
    return
  }

  requestedActionAfterSquirrelReady = null
  if (hasNewerDownloadedVersion) {
    onReadyToReportDownloaded()
  }
}
