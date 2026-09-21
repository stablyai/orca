import { loadElectronAutoUpdater, type ElectronAutoUpdater } from '../electron-updater-loader'
import { statusesEqual } from '../updater-fallback'
import type { UpdateCheckOptions, UpdateStatus } from '../../shared/update-status-types'
import type { UpdateCheckVariant } from './updater-types'
import { UpdaterState as BaseUpdaterState } from './updater-state'

export abstract class UpdaterStatus extends BaseUpdaterState {
  protected getAutoUpdater(): ElectronAutoUpdater {
    if (!this.autoUpdater) {
      this.autoUpdater = loadElectronAutoUpdater()
    }
    return this.autoUpdater
  }

  protected clearAvailableUpdateContext(): void {
    this.availableVersion = null
    this.availableReleaseUrl = null
  }

  protected closeLocalBuildFeed(): void {
    const feed = this.activeLocalBuildFeed
    this.activeLocalBuildFeed = null
    if (feed) {
      void feed.close()
    }
  }

  protected restoreReleaseUpdateSource(): void {
    this.closeLocalBuildFeed()
    this.activeUpdateSource = 'release'
    this.isPinnedBuildActive = false
    if (this.autoUpdater) {
      this.autoUpdater.allowDowngrade = false
      this.autoUpdater.disableDifferentialDownload = false
      // Why: a pinned jump forces allowPrerelease on; leaving it set would opt
      // every later background check into the RC channel behind the user's back.
      this.autoUpdater.allowPrerelease = this.includePrereleaseActive
    }
  }

  protected sendLocalBuildErrorAndRestore(message: string, userInitiated?: boolean): void {
    this.clearAvailableUpdateContext()
    if (
      this.currentStatus.state !== 'error' ||
      this.currentStatus.message !== message ||
      this.currentStatus.userInitiated !== userInitiated ||
      this.currentStatus.source !== 'local'
    ) {
      this.sendStatus({ state: 'error', message, userInitiated, source: 'local' })
    }
    this.restoreReleaseUpdateSource()
  }

  protected clearPrereleaseFallbackContext(): void {
    this.pendingPrereleaseFallback = null
  }

  protected clearPendingUpdateNudge(): void {
    this.activeUpdateNudgeId = null
    this.awaitingNudgeCheckOutcome = false
    this._setPendingUpdateNudgeId?.(null)
  }

  protected deferPendingUpdateNudgeUntilRetry(): void {
    this.activeUpdateNudgeId = null
    this.awaitingNudgeCheckOutcome = false
  }

  protected clearPublishingWindowLastGoodCheck(): void {
    this.publishingWindowLastGoodCheck = null
  }

  protected getPublishingWindowLastGoodCheck(): { lastGoodTag: string } | null {
    return this.publishingWindowLastGoodCheck
  }

  protected getPersistedPendingUpdateNudgeId(): string | null {
    return this._getPendingUpdateNudgeId?.() ?? null
  }

  protected decorateStatusWithActiveNudge(status: UpdateStatus): UpdateStatus {
    // Why: only actionable/error states carry the nudge marker so the renderer knows a dismiss should ack the campaign; cycle-boundary states never need it.
    if (!this.activeUpdateNudgeId) {
      return status
    }
    if (
      status.state === 'idle' ||
      status.state === 'checking' ||
      status.state === 'not-available'
    ) {
      return status
    }
    return { ...status, activeNudgeId: this.activeUpdateNudgeId }
  }

  /** `force` re-delivers a status the renderer must not miss even when it repeats the current one. */
  protected sendStatus(status: UpdateStatus, options?: { force?: boolean }): void {
    const pendingUserInitiatedCheckVariant = this.pendingUserInitiatedCheckAfterInFlight
    const shouldLaunchPendingUserInitiatedCheck =
      pendingUserInitiatedCheckVariant !== null &&
      (status.state === 'idle' ||
        status.state === 'not-available' ||
        status.state === 'available' ||
        status.state === 'error')
    const shouldPreserveNudgeForPublishingWindow =
      this.publishingWindowLastGoodCheck !== null &&
      (status.state === 'idle' ||
        status.state === 'not-available' ||
        status.state === 'available' ||
        status.state === 'error')
    if (this.awaitingNudgeCheckOutcome) {
      if (status.state === 'available') {
        if (shouldPreserveNudgeForPublishingWindow) {
          // Why: a last-good available update is only a temporary fallback; dismissing it must not consume the newest-release nudge campaign.
          this.deferPendingUpdateNudgeUntilRetry()
        } else {
          this.awaitingNudgeCheckOutcome = false
        }
      } else if (
        status.state === 'idle' ||
        status.state === 'not-available' ||
        status.state === 'error'
      ) {
        if (shouldPreserveNudgeForPublishingWindow) {
          // Why: last-good checks can say "not available" while the campaign's newest release is still publishing.
          this.deferPendingUpdateNudgeUntilRetry()
        } else {
          // Why: on no-update, mark the campaign dismissed so a nudge covering already-up-to-date users doesn't re-fire every 30-min poll.
          if (this.activeUpdateNudgeId) {
            this._setDismissedUpdateNudgeId?.(this.activeUpdateNudgeId)
          }
          this.clearPendingUpdateNudge()
        }
      }
    }

    const sourcedStatus: UpdateStatus =
      this.activeUpdateSource === 'release'
        ? status
        : { ...status, source: this.activeUpdateSource }
    const decoratedStatus = this.decorateStatusWithActiveNudge(sourcedStatus)

    if (this.isUpdateCheckResultState(status.state)) {
      this.finishActiveUpdateCheckAttempt()
    }

    if (
      status.state === 'idle' ||
      status.state === 'not-available' ||
      status.state === 'available' ||
      status.state === 'error'
    ) {
      this.clearPublishingWindowLastGoodCheck()
    }

    // Why: reset the in-flight guard once status moves past the window where duplicate download() calls are possible.
    if (
      decoratedStatus.state === 'downloading' ||
      decoratedStatus.state === 'error' ||
      decoratedStatus.state === 'idle'
    ) {
      this.downloadInFlight = false
    }
    if (shouldLaunchPendingUserInitiatedCheck) {
      // Why: a forced status must still land before the queued check restarts the cycle.
      if (options?.force) {
        this.currentStatus = decoratedStatus
        this.mainWindowRef?.webContents.send('updater:status', decoratedStatus)
      }
      this.launchPendingUserInitiatedCheckAfterInFlight(pendingUserInitiatedCheckVariant)
      return
    }
    if (!options?.force && statusesEqual(this.currentStatus, decoratedStatus)) {
      return
    }
    this.currentStatus = decoratedStatus
    this.mainWindowRef?.webContents.send('updater:status', decoratedStatus)
  }

  protected abstract finishActiveUpdateCheckAttempt(): void
  protected abstract isUpdateCheckResultState(state: UpdateStatus['state']): boolean
  protected abstract launchPendingUserInitiatedCheckAfterInFlight(variant: UpdateCheckVariant): void
  protected abstract checkForUpdatesFromMenu(options?: UpdateCheckOptions): void
}
