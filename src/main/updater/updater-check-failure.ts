import { isBenignCheckFailure } from '../updater-fallback'
import { ReleaseFeedPreflightError } from './updater-state'
import type { CheckFailureSource } from './updater-state'
import { UpdaterReleaseFeed } from './updater-release-feed'
import { updaterCodedMessage } from '../../shared/updater-failure-copy'

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
      // Restore the release feed before reporting a failed pinned jump or it blocks all future background checks.
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
        // Transient feed failures need retries; persisting their timestamp would suppress the next startup check.
        console.warn('[updater] benign check failure:', message)
        this.clearAvailableUpdateContext()
        this.scheduleAutomaticUpdateCheck(this.getAutomaticRetryInterval())
        if (userInitiated) {
          // User clicks need visible feedback distinguishing incomplete releases from transport failure.
          this.sendSettledCheckStatus({
            state: 'error',
            ...updaterCodedMessage(
              this.isStableReleaseNotReadyFailure(sourceError)
                ? 'releaseNotReady'
                : 'updateServerUnreachable'
            ),
            userInitiated: true
          })
        } else {
          if (this.isRetryableReleaseFeedPreflightFailure(sourceError)) {
            // Keep the campaign pending through transient probe failures so the short retry can surface it.
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

  protected abstract getAutomaticRetryInterval(): number
}
