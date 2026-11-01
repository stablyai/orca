import { app } from 'electron'
import { isMacInstallRequested } from '../updater-mac-install'
import { withUpdaterSpan } from '../observability/instrumentation'
import {
  AUTO_UPDATE_CHECK_INTERVAL_MS,
  AUTO_UPDATE_RETRY_INTERVAL_MS,
  MAX_AUTO_UPDATE_RETRY_INTERVAL_MS
} from './updater-state'
import { UpdaterCheckFailure } from './updater-check-failure'

export abstract class UpdaterScheduling extends UpdaterCheckFailure {
  protected getAutomaticRetryInterval(): number {
    return AUTO_UPDATE_RETRY_INTERVAL_MS
  }

  protected scheduleAutomaticUpdateCheck(delayMs: number): void {
    let effectiveDelayMs = delayMs
    // The retry constant identifies all retry-cadence callers, keeping backoff centralized.
    if (delayMs === AUTO_UPDATE_RETRY_INTERVAL_MS) {
      effectiveDelayMs = Math.min(
        AUTO_UPDATE_RETRY_INTERVAL_MS * 2 ** this.consecutiveAutomaticRetrySchedules,
        MAX_AUTO_UPDATE_RETRY_INTERVAL_MS
      )
      this.consecutiveAutomaticRetrySchedules += 1
    }
    if (this.autoUpdateCheckTimer) {
      clearTimeout(this.autoUpdateCheckTimer)
    }
    this.autoUpdateCheckTimer = setTimeout(() => {
      // Long-running apps need main-process timers independent of renderer/relaunch lifetime.
      if (!this.runBackgroundUpdateCheck()) {
        // Deferred checks have no outcome handler; re-arm here or automatic checks stop forever.
        this.scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
      }
    }, effectiveDelayMs)
  }

  protected recordCompletedUpdateCheck(): void {
    this.consecutiveAutomaticRetrySchedules = 0
    this.persistLastUpdateCheckAt?.(Date.now())
  }

  /** Returns false when the check was deferred instead of launched, so timer-driven callers can re-arm. */
  protected runBackgroundUpdateCheck(
    nudgeId: string | null = this.getPersistedPendingUpdateNudgeId()
  ): boolean {
    if (
      this.pendingQuitAndInstallTimer ||
      this.quitAndInstallInProgress ||
      isMacInstallRequested()
    ) {
      return false
    }
    // Pinned jumps own the feed until settled; background checks must not repoint their download.
    if (
      this.activeUpdateSource !== 'release' ||
      this.isPinnedBuildActive ||
      this.localBuildSelectionInProgress ||
      this.pinnedBuildSelectionInProgress
    ) {
      return false
    }
    if (this.backgroundCheckLaunchPending || this.currentStatus.state === 'checking') {
      return false
    }
    if (!app.isPackaged) {
      this.sendStatus({ state: 'not-available' })
      return false
    }
    // Set the campaign before events; persist its ID so the card remains dismissible after relaunch.
    this.activeUpdateNudgeId = nudgeId
    // Track launch before delayed checking events so rapid focus/resume cannot start duplicates.
    this.backgroundCheckLaunchPending = true
    this.backgroundCheckPromotedToUserInitiated = false
    const attemptId = this.beginUpdateCheckAttempt()
    const autoUpdater = this.getAutoUpdater()
    const launch = (): Promise<unknown> | undefined => {
      if (
        this.pendingQuitAndInstallTimer ||
        this.quitAndInstallInProgress ||
        isMacInstallRequested()
      ) {
        return undefined
      }
      if (!this.isActiveUpdateCheckAttempt(attemptId)) {
        return undefined
      }
      this.markUpdateCheckLaunched(attemptId)
      return autoUpdater.checkForUpdates()
    }
    const run = this.pinDefaultReleaseFeed().then(launch)
    void Promise.resolve(run)
      .then(() => this.handleSettledUpdateCheckPromise(attemptId))
      .catch((err) => {
        if (!this.isActiveUpdateCheckAttempt(attemptId)) {
          return
        }
        const wasUserInitiated = this.getSettledCheckUserInitiated()
        this.backgroundCheckLaunchPending = false
        this.backgroundCheckPromotedToUserInitiated = false
        if (wasUserInitiated) {
          this.userInitiatedCheck = false
        }
        void this.sendCheckFailureStatus(
          String(err?.message ?? err),
          wasUserInitiated,
          'promise',
          err
        )
      })
    return true
  }

  protected checkForUpdatesInBackground(): void {
    // This span measures launch, not check outcome; dashboards must filter updater.outcome=launched.
    void withUpdaterSpan({ stage: 'check' }, async (span) => {
      span.setAttribute('updater.outcome', 'launched')
      this.runBackgroundUpdateCheck()
    })
  }

  protected enablePrereleaseManifestChecks(): void {
    this.getAutoUpdater().allowPrerelease = true
  }

  protected enableIncludePrerelease(): void {
    if (this.includePrereleaseActive) {
      return
    }
    // Allow prerelease manifests on the probed generic feed; native GitHub may select cancelled RCs without assets.
    this.enablePrereleaseManifestChecks()
    this.includePrereleaseActive = true
  }
}
