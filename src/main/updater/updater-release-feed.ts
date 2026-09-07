import { app } from 'electron'
import {
  fetchNewerReleaseTagsWithReadiness,
  getReleaseDownloadUrl
} from '../updater-prerelease-feed'
import { isMissingUpdateManifestFailure, isPrereleaseVersion } from '../updater-fallback'
import type { CheckFailureSource } from './updater-state'
import type { UpdateCheckVariant } from './updater-types'
import { ReleaseFeedPreflightError } from './updater-state'
import { UpdaterInstallExecution } from './updater-install-execution'

/** Owns concrete release-feed pinning and the one-shot prerelease fallback. */
export abstract class UpdaterReleaseFeed extends UpdaterInstallExecution {
  protected clearPrereleaseFallbackContextIfSettled(): void {
    if (
      this.pendingPrereleaseFallback?.fallbackResultHandled &&
      !this.pendingPrereleaseFallback.suppressedPrimaryPromiseFailureKey &&
      !this.pendingPrereleaseFallback.suppressedPrimaryEventFailure &&
      !this.pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey &&
      !this.pendingPrereleaseFallback.suppressedFallbackEventFailureKey
    ) {
      this.clearPrereleaseFallbackContext()
    }
  }

  protected getMissingManifestPrereleaseFallbackUserInitiated(): boolean | null {
    if (
      !this.pendingPrereleaseFallback?.retryLaunched ||
      this.pendingPrereleaseFallback.fallbackResultHandled
    ) {
      return null
    }
    return this.pendingPrereleaseFallback.userInitiated
  }

  protected markMissingManifestPrereleaseFallbackChecking(): void {
    if (
      !this.pendingPrereleaseFallback?.retryLaunched ||
      this.pendingPrereleaseFallback.fallbackResultHandled
    ) {
      return
    }
    this.pendingPrereleaseFallback.fallbackCheckingForUpdateSeen = true
  }

  protected consumeMissingManifestPrereleaseFallbackResult(): { userInitiated: boolean } | null {
    if (
      !this.pendingPrereleaseFallback?.retryLaunched ||
      this.pendingPrereleaseFallback.fallbackResultHandled
    ) {
      return null
    }
    const result = { userInitiated: this.pendingPrereleaseFallback.userInitiated }
    this.pendingPrereleaseFallback.fallbackResultHandled = true
    this.clearPrereleaseFallbackContextIfSettled()
    return result
  }

  protected suppressMissingManifestPrereleaseFallbackPromiseFailure(message: string): void {
    if (
      !this.pendingPrereleaseFallback?.retryLaunched ||
      this.pendingPrereleaseFallback.fallbackResultHandled
    ) {
      return
    }
    this.pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey = this.getCheckFailureKey(
      message,
      this.pendingPrereleaseFallback.userInitiated
    )
  }

  protected shouldSuppressMissingManifestPrereleaseFallbackEvent(
    message: string,
    error: unknown
  ): boolean {
    if (!this.pendingPrereleaseFallback?.retryLaunched) {
      return false
    }
    const failureKey = this.getCheckFailureKey(
      message,
      this.pendingPrereleaseFallback.userInitiated
    )
    const primaryEventSuppression = this.pendingPrereleaseFallback.suppressedPrimaryEventFailure
    if (primaryEventSuppression?.failureKey === failureKey) {
      const isPrimaryPromisePair = primaryEventSuppression.error === error
      // Why: after fallback checking starts, same-message errors may be the fallback's, so message matching alone isn't safe.
      if (isPrimaryPromisePair || !this.pendingPrereleaseFallback.fallbackCheckingForUpdateSeen) {
        this.pendingPrereleaseFallback.suppressedPrimaryEventFailure = null
        this.clearPrereleaseFallbackContextIfSettled()
        return true
      }
    }
    if (this.pendingPrereleaseFallback.suppressedFallbackEventFailureKey === failureKey) {
      this.pendingPrereleaseFallback.suppressedFallbackEventFailureKey = null
      this.clearPrereleaseFallbackContextIfSettled()
      return true
    }
    return false
  }

  protected markMissingManifestPrereleaseFallbackPromiseHandled(message: string): void {
    if (
      !this.pendingPrereleaseFallback?.retryLaunched ||
      this.pendingPrereleaseFallback.fallbackResultHandled
    ) {
      return
    }
    this.pendingPrereleaseFallback.suppressedFallbackEventFailureKey = this.getCheckFailureKey(
      message,
      this.pendingPrereleaseFallback.userInitiated
    )
  }

  protected async pinDefaultReleaseFeed(
    variant: UpdateCheckVariant = 'default'
  ): Promise<'ready' | 'not-available'> {
    const autoUpdater = this.getAutoUpdater()
    // Why: the latest/download redirect can move between check and download, so pin the concrete tag (prerelease users resolve any channel, stable only stable).
    const currentVersion = app.getVersion()
    const isPerfCheck = variant === 'perf'
    const includePrerelease =
      isPerfCheck || this.includePrereleaseActive || isPrereleaseVersion(currentVersion)
    const releaseTagsResult = await fetchNewerReleaseTagsWithReadiness(
      currentVersion,
      includePrerelease ? 2 : 1,
      {
        includePrerelease,
        ...(isPerfCheck ? { releaseFilter: 'perf' as const } : {})
      }
    )
    const newerTag = releaseTagsResult.tags[0] ?? null
    const fallbackTag = includePrerelease ? (releaseTagsResult.tags[1] ?? null) : null
    this.pendingPrereleaseFallback =
      includePrerelease && newerTag && fallbackTag
        ? {
            primaryTag: newerTag,
            fallbackTag,
            userInitiated: false,
            suppressedPrimaryPromiseFailureKey: null,
            suppressedPrimaryEventFailure: null,
            suppressedFallbackPromiseFailureKey: null,
            suppressedFallbackEventFailureKey: null,
            fallbackResultHandled: false,
            fallbackCheckingForUpdateSeen: false,
            retryLaunched: false
          }
        : null
    // Why: console.info is captured by Console.app/--enable-logging — our only field visibility into the updater.
    if (newerTag) {
      this.clearPublishingWindowLastGoodCheck()
      const url = getReleaseDownloadUrl(newerTag)
      console.info(
        `[updater] release feed pinned: current=${currentVersion} includePrerelease=${includePrerelease} → ${url}`
      )
      autoUpdater.setFeedURL({ provider: 'generic', url })
      return 'ready'
    }
    if (releaseTagsResult.state === 'not-ready') {
      this.clearPrereleaseFallbackContext()
      if (releaseTagsResult.lastGoodTag) {
        // Why: during a publish window the newest tag is unsafe; a verified last-good concrete feed lets electron-updater emit a real result.
        const url = getReleaseDownloadUrl(releaseTagsResult.lastGoodTag)
        console.info(
          `[updater] release feed pinned to last-good: current=${currentVersion} includePrerelease=${includePrerelease} → ${url}`
        )
        this.publishingWindowLastGoodCheck = { lastGoodTag: releaseTagsResult.lastGoodTag }
        autoUpdater.setFeedURL({ provider: 'generic', url })
        return 'ready'
      }
      this.clearPublishingWindowLastGoodCheck()
      console.info(
        `[updater] release feed deferred: current=${currentVersion} includePrerelease=${includePrerelease}; newest release assets are not ready`
      )
      throw new ReleaseFeedPreflightError(
        'release-not-ready',
        isPerfCheck ? 'perf' : includePrerelease ? 'prerelease' : 'default',
        'Latest release artifacts are not ready'
      )
    }
    if (
      releaseTagsResult.state === 'unavailable' &&
      releaseTagsResult.unavailableReason === 'manifest' &&
      !includePrerelease
    ) {
      this.clearPrereleaseFallbackContext()
      this.clearPublishingWindowLastGoodCheck()
      throw new ReleaseFeedPreflightError(
        'manifest-unavailable',
        'default',
        'Unable to find latest version on GitHub'
      )
    }
    if (isPerfCheck) {
      this.clearPrereleaseFallbackContext()
      this.clearPublishingWindowLastGoodCheck()
      if (releaseTagsResult.state === 'no-newer') {
        console.info(
          `[updater] perf release not found: current=${currentVersion} includePrerelease=${includePrerelease}`
        )
        return 'not-available'
      }
      throw new Error('Could not resolve perf update feed')
    }
    this.clearPrereleaseFallbackContext()
    this.clearPublishingWindowLastGoodCheck()
    const url = 'https://github.com/stablyai/orca/releases/latest/download'
    console.info(
      `[updater] release feed fallback: current=${currentVersion} includePrerelease=${includePrerelease} → ${url}`
    )
    autoUpdater.setFeedURL({ provider: 'generic', url })
    return 'ready'
  }

  protected retryPrereleaseFallbackAfterMissingManifest(
    message: string,
    userInitiated: boolean | undefined,
    source: CheckFailureSource,
    failureKey: string,
    sourceError?: unknown
  ): boolean {
    if (
      !this.pendingPrereleaseFallback ||
      this.pendingPrereleaseFallback.retryLaunched ||
      !isMissingUpdateManifestFailure(message)
    ) {
      return false
    }
    const attemptId = this.activeUpdateCheckAttemptId
    if (attemptId === null) {
      return false
    }
    // Why: a published tag can briefly lack its platform manifest mid-release; walk back once to the previous feed for a normal not-available result.
    this.pendingPrereleaseFallback.retryLaunched = true
    this.pendingPrereleaseFallback.userInitiated = Boolean(userInitiated)
    this.pendingPrereleaseFallback.suppressedPrimaryPromiseFailureKey =
      source === 'event' ? failureKey : null
    this.pendingPrereleaseFallback.suppressedPrimaryEventFailure =
      source === 'promise' ? { failureKey, error: sourceError } : null
    this.pendingPrereleaseFallback.fallbackCheckingForUpdateSeen = false
    const { primaryTag, fallbackTag } = this.pendingPrereleaseFallback
    const url = getReleaseDownloadUrl(fallbackTag)
    console.info(
      `[updater] prerelease manifest missing for ${primaryTag}; retrying once against ${url}`
    )
    const autoUpdater = this.getAutoUpdater()
    autoUpdater.setFeedURL({ provider: 'generic', url })
    this.userInitiatedCheck = Boolean(userInitiated)
    this.backgroundCheckLaunchPending = !userInitiated
    this.armUpdateCheckStallTimer(attemptId)
    this.markUpdateCheckLaunched(attemptId)
    void autoUpdater
      .checkForUpdates()
      .then(() => this.handleSettledUpdateCheckPromise(attemptId))
      .catch((err) => {
        if (!this.isActiveUpdateCheckAttempt(attemptId)) {
          return
        }
        const fallbackMessage = String(err?.message ?? err)
        if (userInitiated) {
          this.userInitiatedCheck = false
        } else {
          this.backgroundCheckLaunchPending = false
        }
        this.markMissingManifestPrereleaseFallbackPromiseHandled(fallbackMessage)
        this.consumeMissingManifestPrereleaseFallbackResult()
        void this.sendCheckFailureStatus(fallbackMessage, userInitiated, 'fallback-promise', err)
      })
    return true
  }
}
