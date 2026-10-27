import type { BrowserWindow } from 'electron'
import type { ElectronAutoUpdater } from '../electron-updater-loader'
import type { LocalBuildFeed } from '../local-builds/local-build-feed-server'
import type { UpdateSource, UpdateStatus } from '../../shared/update-status-types'
import type { ReleaseChannel } from '../../shared/release-channel'
import type { PrimaryEventSuppression, UpdateCheckVariant } from './updater-types'

export const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const AUTO_UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000
// #7576: back off persistent feed failures up to this cap; completed checks reset the cadence.
export const MAX_AUTO_UPDATE_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000
export const NUDGE_POLL_INTERVAL_MS = 30 * 60 * 1000
export const NUDGE_ACTIVATION_COOLDOWN_MS = 5 * 60 * 1000
export const QUIT_AND_INSTALL_DELAY_MS = 100
export const PRE_QUIT_CLEANUP_TIMEOUT_MS = 2_500
// Required profile exports may each wait for a bounded writer request.
export const REQUIRED_PRE_QUIT_CLEANUP_TIMEOUT_MS = 90_000
export const UPDATE_CHECK_SILENT_SETTLE_DELAY_MS = 1_000
export const UPDATE_CHECK_STALL_TIMEOUT_MS = 45_000
// Squirrel re-reads/verifies the bundle through localhost; report prolonged silence instead of leaving staging invisible.
export const MAC_DEFERRED_STAGING_TIMEOUT_MS = 120_000

export type CheckFailureSource = 'event' | 'promise' | 'fallback-promise'
export type MissingManifestPrereleaseFallbackResult = { userInitiated: boolean }
export type ReleaseFeedPreflightFailure = 'manifest-unavailable' | 'release-not-ready'
export type ReleaseFeedPreflightResult = 'ready' | 'not-available'
export type UpdateInstallMode =
  | 'interactive'
  | 'supervised-headless-serve'
  | 'unsupported-headless-serve'
export type PreQuitCleanupFailureMode = 'continue' | 'abort'

// Typed preflight context keeps UI routing independent of error-text matching.
export class ReleaseFeedPreflightError extends Error {
  constructor(
    readonly reason: ReleaseFeedPreflightFailure,
    readonly releaseChannel: UpdateCheckVariant,
    message: string
  ) {
    super(message)
    this.name = 'ReleaseFeedPreflightError'
  }
}

export abstract class UpdaterState {
  protected mainWindowRef: BrowserWindow | null = null
  protected currentStatus: UpdateStatus = { state: 'idle' }
  protected userInitiatedCheck = false
  protected onBeforeQuitCleanup: (() => void | Promise<void>) | null = null
  protected onBeforeQuitFailure: PreQuitCleanupFailureMode = 'continue'
  protected autoUpdaterInitialized = false
  // Modifier checks include prereleases but still pin a manifest-probed tag, skipping cancelled RCs.
  protected includePrereleaseActive = false
  protected availableVersion: string | null = null
  protected availableReleaseUrl: string | null = null
  protected pendingCheckFailureKey: string | null = null
  protected pendingCheckFailurePromise: Promise<void> | null = null
  protected autoUpdateCheckTimer: ReturnType<typeof setTimeout> | null = null
  protected nudgeCheckTimer: ReturnType<typeof setTimeout> | null = null
  protected pendingQuitAndInstallTimer: ReturnType<typeof setTimeout> | null = null
  protected macDeferredStagingTimer: ReturnType<typeof setTimeout> | null = null
  protected quitAndInstallInProgress = false
  protected updateInstallMode: UpdateInstallMode = 'interactive'
  protected lastInstallDeferralVersion = {
    download: null as string | null,
    install: null as string | null
  }
  // Late errors after commit must not clear quittingForUpdate or dock activate could reopen mid-install.
  protected updateInstallCommitted = false
  // Only native-invoked failures can recover; pre-native errors must not clear quittingForUpdate.
  protected quitAndInstallNativeInvoked = false
  protected persistLastUpdateCheckAt: ((timestamp: number) => void) | null = null
  protected _getLastUpdateCheckAt: (() => number | null) | null = null
  protected backgroundCheckLaunchPending = false
  // Retain promotion on the launch because its error event can precede the promise catch.
  protected backgroundCheckPromotedToUserInitiated = false
  protected updateCheckStallTimer: ReturnType<typeof setTimeout> | null = null
  protected updateCheckSilentSettleTimer: ReturnType<typeof setTimeout> | null = null
  protected updateCheckAttemptSequence = 0
  protected activeUpdateCheckAttemptId: number | null = null
  protected activeUpdateCheckLaunchAttemptId: number | null = null
  protected activeUpdateCheckEventAttemptId: number | null = null
  protected updateAvailableEventPendingAttemptId: number | null = null
  protected pendingUserInitiatedCheckAfterInFlight: UpdateCheckVariant | null = null
  protected activeUpdateNudgeId: string | null = null
  protected awaitingNudgeCheckOutcome = false
  protected nudgeCheckInFlight = false
  protected lastNudgeCheckAt = 0
  protected publishingWindowLastGoodCheck: { lastGoodTag: string } | null = null
  protected pendingPrereleaseFallback: {
    primaryTag: string
    fallbackTag: string
    // Primary cleanup may run after fallback starts; fallback needs attempt-scoped state, not mutable globals.
    userInitiated: boolean
    suppressedPrimaryPromiseFailureKey: string | null
    suppressedPrimaryEventFailure: PrimaryEventSuppression | null
    suppressedFallbackPromiseFailureKey: string | null
    suppressedFallbackEventFailureKey: string | null
    fallbackResultHandled: boolean
    fallbackCheckingForUpdateSeen: boolean
    retryLaunched: boolean
  } | null = null

  protected _getPendingUpdateNudgeId: (() => string | null) | null = null
  protected _getDismissedUpdateNudgeId: (() => string | null) | null = null
  protected _setPendingUpdateNudgeId: ((id: string | null) => void) | null = null
  protected _setDismissedUpdateNudgeId: ((id: string | null) => void) | null = null
  // Guard duplicate download calls before status changes to downloading.
  protected downloadInFlight = false
  /** Guards the macOS `activate` handler from reopening the old version while ShipIt replaces the .app bundle. */
  protected quittingForUpdate = false
  protected autoUpdater: ElectronAutoUpdater | null = null
  protected activeUpdateSource: 'release' | UpdateSource = 'release'
  protected activeLocalBuildFeed: LocalBuildFeed | null = null
  protected localBuildSelectionInProgress = false
  // Dev-channel/tag jumps permit intentional downgrade from the real release feed.
  protected pinnedBuildSelectionInProgress = false
  // Pinned release tags still represent deliberate downgrades; bypass newer-only gates.
  protected isPinnedBuildActive = false
  protected getReleaseChannelOverride: (() => ReleaseChannel | null) | null = null

  protected consecutiveAutomaticRetrySchedules = 0
  protected readonly installFailureCauseMaxLength = 200

  constructor() {}

  // The ref outlives a closed window, whose webContents getter throws once destroyed.
  protected sendToMainWindow(channel: string, ...args: unknown[]): void {
    const win = this.mainWindowRef
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      return
    }
    win.webContents.send(channel, ...args)
  }
}
