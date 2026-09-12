import { isBenignCheckFailure } from '../updater-fallback'
import { ReleaseFeedPreflightError } from './updater-state'
import type { CheckFailureSource } from './updater-state'
import { UpdaterReleaseFeed } from './updater-release-feed'

/** Normalizes check failures, retry policy, and release-feed preflight diagnostics. */
export abstract class UpdaterCheckFailure extends UpdaterReleaseFeed {
  protected isRetryableReleaseFeedPreflightFailure(sourceError: unknown): boolean {
    return (
      sourceError instanceof ReleaseFeedPreflightError &&
      (sourceError.reason === 'release-not-ready' || sourceError.reason === 'manifest-unavailable')
    )
  }

  protected isStableReleaseNotReadyFailure(sourceError: unknown): boolean {
    return (
      sourceError instanceof ReleaseFeedPreflightError &&
      sourceError.reason === 'release-not-ready' &&
      sourceError.releaseChannel === 'default'
    )
  }

  protected async sendCheckFailureStatus(
    message: string,
    userInitiated?: boolean,
    source: CheckFailureSource = 'promise',
    sourceError?: unknown
  ): Promise<void> {
    if (this.activeUpdateSource === 'local') {
      this.sendLocalBuildErrorAndRestore(message, userInitiated)
      return
    }
    if (this.isPinnedBuildActive) {
      // Why: a failed pinned jump must hand the feed back before surfacing the error, or the pin blocks background checks for the process lifetime.
      this.clearAvailableUpdateContext()
      this.restoreReleaseUpdateSource()
      this.sendSettledCheckStatus({ state: 'error', message, userInitiated })
      return
    }
    const failureKey = this.getCheckFailureKey(message, userInitiated)
    if (
      source === 'promise' &&
      this.pendingPrereleaseFallback?.suppressedPrimaryPromiseFailureKey === failureKey
    ) {
      this.pendingPrereleaseFallback.suppressedPrimaryPromiseFailureKey = null
      this.clearPrereleaseFallbackContextIfSettled()
      return
    }
    if (
      source === 'fallback-promise' &&
      this.pendingPrereleaseFallback?.suppressedFallbackPromiseFailureKey === failureKey
    ) {
      this.pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey = null
      this.clearPrereleaseFallbackContextIfSettled()
      return
    }
    if (
      this.retryPrereleaseFallbackAfterMissingManifest(
        message,
        userInitiated,
        source,
        failureKey,
        sourceError
      )
    ) {
      return
    }
    if (this.pendingCheckFailureKey === failureKey && this.pendingCheckFailurePromise) {
      return this.pendingCheckFailurePromise
    }

    const handleFailure = async (): Promise<void> => {
      if (
        isBenignCheckFailure(message) ||
        this.isRetryableReleaseFeedPreflightFailure(sourceError)
      ) {
        // Why: benign failures (incomplete latest.yml, network blips) are transient — retry, and skip persisting the timestamp (would suppress the next startup check).
        console.warn('[updater] benign check failure:', message)
        this.clearAvailableUpdateContext()
        this.scheduleAutomaticUpdateCheck(this.getAutomaticRetryInterval())
        if (userInitiated) {
          // Why: a user click needs visible feedback (idle looks broken); distinguish incomplete releases from transport failures.
          this.sendSettledCheckStatus({
            state: 'error',
            message: this.isStableReleaseNotReadyFailure(sourceError)
              ? "A newer release isn't available for this device yet. Check again later."
              : "Couldn't reach the update server. Try again in a few minutes.",
            userInitiated: true
          })
        } else {
          if (this.isRetryableReleaseFeedPreflightFailure(sourceError)) {
            // Why: release probes can fail transiently; keep the campaign pending so the short retry can still show it.
            this.deferPendingUpdateNudgeUntilRetry()
          }
          this.sendSettledCheckStatus({ state: 'idle' })
        }
        return
      }
      this.clearAvailableUpdateContext()
      this.persistLastUpdateCheckAt?.(Date.now())
      if (!userInitiated) {
        this.scheduleAutomaticUpdateCheck(this.getAutomaticRetryInterval())
      }
      this.sendSettledCheckStatus({ state: 'error', message, userInitiated })
    }

    this.pendingCheckFailureKey = failureKey
    this.pendingCheckFailurePromise = handleFailure().finally(() => {
      if (this.pendingCheckFailureKey === failureKey) {
        this.pendingCheckFailureKey = null
        this.pendingCheckFailurePromise = null
      }
    })
    return this.pendingCheckFailurePromise
  }

  /** Keeps retry interval access in one place for the scheduling layer. */
  protected abstract getAutomaticRetryInterval(): number
}
