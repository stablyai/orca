import { beginMacUpdateDownload, deferMacQuitUntilInstallerReady } from '../updater-mac-install'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { isExternallyManagedLinuxInstall } from '../linux-update-package-type'
import { LINUX_PACKAGE_EXTERNALLY_MANAGED_MESSAGE } from '../linux-package-downloaded-status'
import { QUIT_AND_INSTALL_DELAY_MS } from './updater-state'
import { UpdaterRemoteStatus } from './updater-remote-status'

/** Coordinates renderer-facing download/install actions and their duplicate guards. */
export abstract class UpdaterDownloadInstall extends UpdaterRemoteStatus {
  protected quitAndInstall(): void {
    if (
      this.localBuildSelectionInProgress ||
      this.pinnedBuildSelectionInProgress ||
      this.pendingQuitAndInstallTimer ||
      this.quitAndInstallInProgress
    ) {
      return
    }

    if (this.deferHeadlessServeInstall('install', this.getPendingInstallVersion())) {
      return
    }
    if (
      deferMacQuitUntilInstallerReady(
        this.currentStatus,
        this.hasInstallableDownloadedVersion(),
        () => this.getPendingInstallVersion(),
        (status) => this.sendStatus(status)
      )
    ) {
      return
    }

    // Why: defer the quit a tick so the renderer can flush dismissals/state before windows start closing.
    this.pendingQuitAndInstallTimer = setTimeout(() => {
      void this.performQuitAndInstall()
    }, QUIT_AND_INSTALL_DELAY_MS)
  }

  protected downloadUpdate(): void {
    if (
      this.localBuildSelectionInProgress ||
      this.pinnedBuildSelectionInProgress ||
      this.downloadInFlight
    ) {
      return
    }
    // Why: allow retry from 'error' (availableVersion stays cached) so the error card's Retry Download button works.
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
    // Why: main owns this verdict, not the card — an older renderer or a direct IPC call must not be
    // able to spend a package download that this host could never install.
    if (isExternallyManagedLinuxInstall()) {
      recordUpdaterLifecycle('linux_package_externally_managed_download_blocked', {
        version
      })
      // Why: a pinned jump resolves to 'release' on Linux (no dev-channel artifact is built for it),
      // so refusing without unwinding would strand isPinnedBuildActive and silently kill every
      // background check for the rest of the process. A no-op on the ordinary release path.
      this.clearAvailableUpdateContext()
      this.restoreReleaseUpdateSource()
      this.sendStatus({
        state: 'error',
        message: LINUX_PACKAGE_EXTERNALLY_MANAGED_MESSAGE,
        version,
        retryable: false
      })
      return
    }
    if (this.deferHeadlessServeInstall('download', version)) {
      return
    }
    this.downloadInFlight = true
    const localBuildDownload = this.activeUpdateSource === 'local'
    beginMacUpdateDownload()
    // Why: setup can take seconds before progress emits; surface acceptance now so the action never looks inert.
    this.sendStatus({ state: 'downloading', percent: 0, version })
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

  protected isQuittingForUpdate(): boolean {
    return this.quittingForUpdate
  }
}
