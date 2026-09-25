import type { BrowserWindow } from 'electron'
import type { ElectronAutoUpdater } from '../electron-updater-loader'
import type { LocalBuildFeed } from '../local-builds/local-build-feed-server'
import type { UpdateSource, UpdateStatus } from '../../shared/update-status-types'
import type { ReleaseChannel } from '../../shared/release-channel'
import type { PrimaryEventSuppression, UpdateCheckVariant } from './updater-types'

export const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const AUTO_UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000
// Why: a persistently-failing feed used to re-arm the retry at a fixed 1h cadence forever (issue #7576); backoff doubles per failure up to this cap, any completed check resets.
export const MAX_AUTO_UPDATE_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000
export const NUDGE_POLL_INTERVAL_MS = 30 * 60 * 1000
export const NUDGE_ACTIVATION_COOLDOWN_MS = 5 * 60 * 1000
export const QUIT_AND_INSTALL_DELAY_MS = 100
export const PRE_QUIT_CLEANUP_TIMEOUT_MS = 2_500
export const UPDATE_CHECK_SILENT_SETTLE_DELAY_MS = 1_000
export const UPDATE_CHECK_STALL_TIMEOUT_MS = 45_000

export type CheckFailureSource = 'event' | 'promise' | 'fallback-promise'
export type MissingManifestPrereleaseFallbackResult = { userInitiated: boolean }
export type ReleaseFeedPreflightFailure = 'manifest-unavailable' | 'release-not-ready'
export type ReleaseFeedPreflightResult = 'ready' | 'not-available'
export type UpdateInstallMode =
  | 'interactive'
  | 'supervised-headless-serve'
  | 'unsupported-headless-serve'

// Why: expected preflight outcomes need typed context so UI routing never depends on matching error text.
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
  protected autoUpdaterInitialized = false
  // Why: modifier-clicking "Check for Updates" targets prerelease manifests; the feed still pins a concrete tag so cancelled prereleases without manifests are skipped.
  protected includePrereleaseActive = false
  protected availableVersion: string | null = null
  protected availableReleaseUrl: string | null = null
  protected pendingCheckFailureKey: string | null = null
  protected pendingCheckFailurePromise: Promise<void> | null = null
  protected autoUpdateCheckTimer: ReturnType<typeof setTimeout> | null = null
  protected nudgeCheckTimer: ReturnType<typeof setTimeout> | null = null
  protected pendingQuitAndInstallTimer: ReturnType<typeof setTimeout> | null = null
  protected quitAndInstallInProgress = false
  protected updateInstallMode: UpdateInstallMode = 'interactive'
  protected lastInstallDeferralVersion = {
    download: null as string | null,
    install: null as string | null
  }
  // Why: once install has committed, late 'error' events must not clear quittingForUpdate — that would re-enable dock activate mid-installer.
  protected updateInstallCommitted = false
  // Why: recovery must only run after the native quitAndInstall call; pre-native errors must not clear quittingForUpdate or look like install recovery.
  protected quitAndInstallNativeInvoked = false
  protected persistLastUpdateCheckAt: ((timestamp: number) => void) | null = null
  protected _getLastUpdateCheckAt: (() => number | null) | null = null
  protected backgroundCheckLaunchPending = false
  // Why: a promoted background check can emit an error event before its promise catch runs; keep the promotion attached to that launch.
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
    // Why: primary promise cleanup can run after fallback starts; fallback events need this attempt-scoped state, not the mutable global.
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
  // Why: guards against duplicate download() calls while an accepted request transitions status to 'downloading'.
  protected downloadInFlight = false
  /** Guards the macOS `activate` handler from reopening the old version while ShipIt replaces the .app bundle. */
  protected quittingForUpdate = false
  protected autoUpdater: ElectronAutoUpdater | null = null
  protected activeUpdateSource: 'release' | UpdateSource = 'release'
  protected activeLocalBuildFeed: LocalBuildFeed | null = null
  protected localBuildSelectionInProgress = false
  // Why: a dev channel/tag jump may target an older build, so it needs allowDowngrade
  // like local builds — but off a real release feed, not a loopback server.
  protected pinnedBuildSelectionInProgress = false
  // Why: a pinned jump to a stable/rc tag keeps the 'release' source but is still a
  // deliberate downgrade, so newer-only gates must yield to it too.
  protected isPinnedBuildActive = false
  protected getReleaseChannelOverride: (() => ReleaseChannel | null) | null = null

  protected consecutiveAutomaticRetrySchedules = 0
  protected readonly installFailureCauseMaxLength = 200

  constructor() {}
}
