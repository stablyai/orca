import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { withUpdaterSpan } from '../observability/instrumentation'
import {
  AUTO_UPDATE_CHECK_INTERVAL_MS,
  AUTO_UPDATE_RETRY_INTERVAL_MS,
  MAX_AUTO_UPDATE_RETRY_INTERVAL_MS
} from './updater-state'
import { UpdaterCheckFailure } from './updater-check-failure'

/** Owns timer-driven checks and the shared check-launch bookkeeping. */
export abstract class UpdaterScheduling extends UpdaterCheckFailure {
  protected getAutomaticRetryInterval(): number {
    return AUTO_UPDATE_RETRY_INTERVAL_MS
  }

  protected scheduleAutomaticUpdateCheck(delayMs: number): void {
    let effectiveDelayMs = delayMs
    // All retry-cadence callers pass exactly this constant, so keying backoff on it keeps one choke point instead of threading a flag through every schedule site.
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
      // Why: Orca runs for days, so keep the next background check scheduled in the main process rather than tying it to relaunches or renderer lifetime.
      if (!this.runBackgroundUpdateCheck()) {
        // Why: a deferred check reaches no outcome handler, so re-arm here or one deferral ends automatic checks for the process lifetime.
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
    // Why: a pinned dev jump owns the feed until it settles; a background check would repoint it mid-flight and download the wrong build.
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
    if (!app.isPackaged || is.dev) {
      this.sendStatus({ state: 'not-available' })
      return false
    }
    // Why: set the nudge marker before any events arrive so later checks can't inherit a stale campaign id; persisted id keeps a nudge card dismissable after relaunch.
    this.activeUpdateNudgeId = nudgeId
    // Why: 'checking-for-update' arrives a tick later, so a second focus/resume can slip in before status flips; track launch in memory to dedupe that gap.
    this.backgroundCheckLaunchPending = true
    this.backgroundCheckPromotedToUserInitiated = false
    const attemptId = this.beginUpdateCheckAttempt()
    const autoUpdater = this.getAutoUpdater()
    const launch = (): Promise<unknown> | undefined => {
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
    // Why: span records only check launch (always Success), not outcome; dashboards must filter `updater.outcome === 'launched'`, not this span's success rate.
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
    // Why: this flag makes electron-updater accept prerelease manifests; we keep the manifest-probed generic feed over the native GitHub provider because cancelled RCs can appear without assets.
    this.enablePrereleaseManifestChecks()
    this.includePrereleaseActive = true
  }
}
