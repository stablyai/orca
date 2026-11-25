import { app } from 'electron'
import {
  beginMacUpdateDownload,
  deferMacQuitUntilInstallerReady,
  holdMacInstallUntilInstallerReady,
  isMacInstallRequested,
  resumeHeldMacQuit,
  retireMacInstallIntentAfterStagingFailure,
  setMacInstallPreflightInProgress
} from '../mac-install/updater-mac-install'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import { isExternallyManagedLinuxInstall } from '../linux-package/linux-update-package-type'
import type { UpdateStatus } from '../../../shared/updater/update-status-types'
import { updaterCodedMessage } from '../../../shared/updater/updater-failure-copy'
import { isShowingMacStaging } from '../../../shared/updater/update-staging-status'
import {
  AUTO_UPDATE_RETRY_INTERVAL_MS,
  MAC_INTERACTIVE_STAGING_TIMEOUT_MS,
  QUIT_AND_INSTALL_DELAY_MS
} from './updater-state'
import { UpdaterRequiredRestart } from './updater-required-restart'
import { prepareThisProcessShipItStaging } from '../mac-install/shipit-leftover-recovery'
import type { DownloadStatusOptions, UpdateInstallTrigger } from './updater-state'

export abstract class UpdaterDownloadInstall extends UpdaterRequiredRestart {
  private macStagingTimer: ReturnType<typeof setTimeout> | null = null

  protected quitAndInstall(
    trigger: UpdateInstallTrigger = 'manual',
    isCurrentTeamRestart?: () => boolean
  ): void {
    if (
      this.localBuildSelectionInProgress ||
      this.pinnedBuildSelectionInProgress ||
      this.pendingQuitAndInstallTimer ||
      this.quitAndInstallInProgress ||
      isMacInstallRequested()
    ) {
      return
    }

    const version = this.getPendingInstallVersion()
    if (this.holdUpdateForTeamPolicy(version)) {
      this.sendToMainWindow('updater:quitAndInstallAborted')
      return
    }
    if (this.deferHeadlessServeInstall('install', version)) {
      return
    }
    // A queued check must not repoint the feed while native staging or installation is pending.
    this.finishActiveUpdateCheckAttempt()
    this.clearBackgroundCheckLaunchPending()
    if (this.macInstallerStagingVersion !== null) {
      // Squirrel still owns staging, before or after the guidance deadline: only its native result may start an install.
      holdMacInstallUntilInstallerReady()
      return
    }
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
      void this.performRecordedInstall(trigger, isCurrentTeamRestart)
    }, QUIT_AND_INSTALL_DELAY_MS)
  }

  protected publishUpdateOffer(
    status: UpdateStatus,
    { eligible, backgroundCheck }: { eligible: boolean; backgroundCheck: boolean }
  ): void {
    if (status.state === 'available' && this.holdUpdateForTeamPolicy(status.version)) {
      return
    }
    const required = status.state === 'available' && this.isRequiredTeamUpdate(status.version)
    if (status.state === 'available' && this.autoUpdater && this.implicitInstallOnQuit) {
      this.macTeamDownloadDeferred = this.shouldDeferTeamMacStaging()
      this.autoUpdater.autoInstallOnAppQuit = !required && !this.macTeamDownloadDeferred
    }
    this.automaticDownloadOfferVersion =
      eligible && backgroundCheck && status.state === 'available' ? status.version : null
    const autoDownload =
      backgroundCheck &&
      this.pendingUserInitiatedCheckAfterInFlight === null &&
      status.state === 'available' &&
      this.canDownloadAutomatically(status.version)
    this.sendStatus(
      required
        ? { ...status, ...this.requiredUpdateStatusFields() }
        : autoDownload
          ? { ...status, automaticDownload: true }
          : status
    )
    if (required && status.state === 'available' && !status.externallyManaged) {
      this.downloadUpdate()
    } else if (autoDownload) {
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
          failurePhase: 'download',
          version,
          retryable: false,
          ...updaterCodedMessage('macStagingTimeout')
        })
      }
    }, MAC_INTERACTIVE_STAGING_TIMEOUT_MS)
  }

  /** Squirrel's native error ends interactive staging. JS failures were held back while it owned the attempt, so publish the failure here. */
  protected failNativeMacStaging(error: unknown): void {
    const version = this.finishMacStaging()
    if (version !== null) {
      // Retire a saved Restart and its fallback before the failure card re-enables Check, Switch and Retry.
      const resumeQuit = retireMacInstallIntentAfterStagingFailure()
      if (isShowingMacStaging(this.currentStatus, version)) {
        const cause =
          error instanceof Error ? error.message : typeof error === 'string' ? error : ''
        const message = cause || 'Unknown error'
        if (this.activeUpdateSource === 'local') {
          this.sendLocalBuildErrorAndRestore(message)
        } else {
          this.sendStatus({ state: 'error', failurePhase: 'download', version, message })
          if (this.isPinnedBuildActive) {
            this.restoreReleaseUpdateSource()
          }
        }
      }
      if (resumeQuit) {
        resumeHeldMacQuit()
      }
    }
    this.failMacStaging(error)
  }

  /** While Squirrel owns interactive staging the visible status stays the staging status; only its native result may settle it. */
  protected ignoreJsFailureDuringMacStaging(source: 'error_event' | 'download_promise'): boolean {
    if (this.macInstallerStagingVersion === null) {
      return false
    }
    recordUpdaterLifecycle('macos_js_failure_during_native_staging', { source })
    return true
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

  protected publishDownloadStatus(status: UpdateStatus, options?: DownloadStatusOptions): void {
    if (status.state === 'downloading' && this.isRequiredTeamUpdate(status.version)) {
      this.sendStatus({ ...status, ...this.requiredUpdateStatusFields() })
      return
    }
    if (status.state === 'downloaded') {
      this.finishMacStaging()
      if (this.holdUpdateForTeamPolicy(status.version)) {
        return
      }
      if (this.isRequiredTeamUpdate(status.version)) {
        this.publishRequiredDownload(status)
        return
      }
    }
    if (status.state !== 'downloaded' || status.version !== this.automaticDownloadVersion) {
      this.sendStatus(status)
      return
    }
    if (this.pendingQuitAndInstallTimer || this.quitAndInstallInProgress) {
      return
    }
    const automatic =
      this.getAutomaticUpdates?.() === true && options?.allowAutomaticInstall !== false
    this.sendStatus(automatic ? { ...status, installing: true } : status, { force: true })
    if (automatic) {
      this.quitAndInstall('automatic')
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
      this.implicitInstallOnQuit &&
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
    if (!version || this.holdUpdateForTeamPolicy(version)) {
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
    const required = this.isRequiredTeamUpdate(version)
    this.sendStatus({
      state: 'downloading',
      percent: 0,
      version,
      ...(required ? this.requiredUpdateStatusFields() : {})
    })
    const startDownload = (): void => {
      if (this.holdUpdateForTeamPolicy(version)) {
        this.downloadInFlight = false
        return
      }
      this.getAutoUpdater()
        .downloadUpdate()
        .catch((err) => {
          this.downloadInFlight = false
          const message = String(err?.message ?? err)
          if (this.ignoreJsFailureDuringMacStaging('download_promise')) {
            return
          }
          if (localBuildDownload) {
            this.sendLocalBuildErrorAndRestore(message)
          } else {
            this.sendErrorStatus(message)
            if (this.isRequiredTeamUpdate(version)) {
              this.scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
            }
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

  /** True once the native updater is closing windows to install; false during preflight, cleanup or deferred staging. */
  isNativeUpdateInstallUnderWay(): boolean {
    return this.quitAndInstallNativeInvoked && !this.isAwaitingMacStaging()
  }
}
