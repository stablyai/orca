import { app } from 'electron'
import {
  beginMacUpdateDownload,
  deferMacQuitUntilInstallerReady,
  isMacInstallRequested,
  setMacInstallPreflightInProgress
} from '../mac-install/updater-mac-install'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { isExternallyManagedLinuxInstall } from '../linux-package/linux-update-package-type'
import type { UpdateStatus } from '../../../shared/updater/update-status-types'
import { updaterCodedMessage } from '../../../shared/updater/updater-failure-copy'
import { MAC_DEFERRED_STAGING_TIMEOUT_MS, QUIT_AND_INSTALL_DELAY_MS } from './updater-state'
import { UpdaterRemoteStatus } from './updater-remote-status'
import { prepareThisProcessShipItStaging } from '../mac-install/shipit-leftover-recovery'

export abstract class UpdaterDownloadInstall extends UpdaterRemoteStatus {
  private macStagingTimer: ReturnType<typeof setTimeout> | null = null

  protected quitAndInstall(automatic = false): void {
    if (
      this.localBuildSelectionInProgress ||
      this.pinnedBuildSelectionInProgress ||
      this.pendingQuitAndInstallTimer ||
      this.quitAndInstallInProgress ||
      isMacInstallRequested()
    ) {
      return
    }

    if (this.deferHeadlessServeInstall('install', this.getPendingInstallVersion())) {
      return
    }
    // A queued check must not repoint the feed while native staging or installation is pending.
    this.finishActiveUpdateCheckAttempt()
    this.clearBackgroundCheckLaunchPending()
    if (
      !this.isMacStagingDeferredToInstall() &&
      deferMacQuitUntilInstallerReady(
        this.currentStatus,
        this.hasInstallableDownloadedVersion(),
        () => this.getPendingInstallVersion(),
        (status) => this.sendStatus(status)
      )
    ) {
      return
    }

    if (process.platform === 'darwin') {
      setMacInstallPreflightInProgress(true)
    }
    // Defer quit one tick so the renderer can flush state before windows close.
    this.pendingQuitAndInstallTimer = setTimeout(() => {
      void this.performQuitAndInstall(automatic)
    }, QUIT_AND_INSTALL_DELAY_MS)
  }

  protected publishUpdateOffer(
    status: UpdateStatus,
    { eligible, backgroundCheck }: { eligible: boolean; backgroundCheck: boolean }
  ): void {
    this.automaticDownloadOfferVersion =
      eligible && backgroundCheck && status.state === 'available' ? status.version : null
    const autoDownload =
      backgroundCheck &&
      this.pendingUserInitiatedCheckAfterInFlight === null &&
      status.state === 'available' &&
      this.canDownloadAutomatically(status.version)
    this.sendStatus(autoDownload ? { ...status, automaticDownload: true } : status)
    if (autoDownload) {
      this.downloadAvailableUpdateAutomatically()
    }
  }

  protected watchMacStaging(version: string): void {
    if (this.macInstallerStagingVersion !== null) {
      return
    }
    this.macInstallerStagingVersion = version
    this.macStagingTimer = setTimeout(() => {
      this.macStagingTimer = null
      if (this.currentStatus.state === 'downloading' && this.currentStatus.version === version) {
        // Squirrel may still finish this attempt. Keep its version fenced until a native result.
        this.sendStatus({
          state: 'error',
          version,
          retryable: false,
          ...updaterCodedMessage('macStagingTimeout')
        })
      }
    }, MAC_DEFERRED_STAGING_TIMEOUT_MS)
  }

  protected finishMacStaging(): string | null {
    const version = this.macInstallerStagingVersion
    this.macInstallerStagingVersion = null
    if (this.macStagingTimer) {
      clearTimeout(this.macStagingTimer)
      this.macStagingTimer = null
    }
    return version
  }

  protected publishDownloadStatus(status: UpdateStatus): void {
    if (status.state === 'downloaded') {
      this.finishMacStaging()
    }
    if (status.state !== 'downloaded' || status.version !== this.automaticDownloadVersion) {
      this.sendStatus(status)
      return
    }
    if (this.pendingQuitAndInstallTimer || this.quitAndInstallInProgress) {
      return
    }
    const automatic = this.getAutomaticUpdates?.() === true
    this.sendStatus(automatic ? { ...status, installing: true } : status, { force: true })
    if (automatic) {
      this.quitAndInstall(true)
    }
  }

  protected downloadAvailableUpdateAutomatically(): void {
    if (
      !this.backgroundCheckLaunchPending &&
      this.currentStatus.state === 'available' &&
      this.canDownloadAutomatically(this.currentStatus.version)
    ) {
      this.downloadUpdate(true)
    }
  }

  private canDownloadAutomatically(version: string): boolean {
    return (
      app.isPackaged &&
      this.getAutomaticUpdates?.() === true &&
      this.autoUpdater?.autoInstallOnAppQuit === true &&
      this.automaticDownloadOfferVersion === version &&
      this.activeUpdateSource === 'release' &&
      !this.isPinnedBuildActive
    )
  }

  protected downloadUpdate(automatic = false): void {
    if (
      this.localBuildSelectionInProgress ||
      this.pinnedBuildSelectionInProgress ||
      this.pendingQuitAndInstallTimer ||
      this.quitAndInstallInProgress ||
      isMacInstallRequested() ||
      this.macInstallerStagingVersion !== null ||
      this.downloadInFlight
    ) {
      return
    }
    // Retain availableVersion after errors so Retry Download still works.
    const canStart =
      this.currentStatus.state === 'available' ||
      (this.currentStatus.state === 'error' && this.hasInstallableDownloadedVersion())
    if (!canStart) {
      return
    }
    const version =
      this.currentStatus.state === 'available' ? this.currentStatus.version : this.availableVersion
    if (!version) {
      return
    }
    // Enforce host installability in main for older renderers and direct IPC callers.
    if (isExternallyManagedLinuxInstall()) {
      recordUpdaterLifecycle('linux_package_externally_managed_download_blocked', {
        version
      })
      // A refused Linux pin still owns the release feed; unwind it or background checks remain disabled.
      this.clearAvailableUpdateContext()
      this.restoreReleaseUpdateSource()
      this.sendStatus({
        state: 'error',
        ...updaterCodedMessage('linuxPackageExternallyManaged'),
        version,
        retryable: false
      })
      return
    }
    if (this.deferHeadlessServeInstall('download', version)) {
      return
    }
    this.finishMacStaging()
    this.automaticDownloadVersion = automatic ? version : null
    this.downloadInFlight = true
    const localBuildDownload = this.activeUpdateSource === 'local'
    beginMacUpdateDownload()
    // Acknowledge acceptance before setup delays progress events so the card responds immediately.
    this.sendStatus({ state: 'downloading', percent: 0, version })
    const startDownload = (): void => {
      this.getAutoUpdater()
        .downloadUpdate()
        .catch((err) => {
          this.downloadInFlight = false
          const message = String(err?.message ?? err)
          if (localBuildDownload) {
            this.sendLocalBuildErrorAndRestore(message)
          } else {
            this.sendErrorStatus(message)
          }
        })
    }
    // Prepare before download because Squirrel stages on completion unless staging is deferred to install.
    const preparingStaging = this.isMacStagingDeferredToInstall()
      ? null
      : prepareThisProcessShipItStaging()
    if (preparingStaging) {
      void preparingStaging.then(startDownload)
    } else {
      startDownload()
    }
  }

  protected isQuittingForUpdate(): boolean {
    return this.quittingForUpdate
  }
}
