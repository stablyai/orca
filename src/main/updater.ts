/* eslint-disable max-lines */
import { app, BrowserWindow, powerMonitor } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { NsisUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import type { UpdateStatus } from '../shared/types'
import { killAllPty } from './ipc/pty'
import {
  beginMacUpdateDownload,
  deferMacQuitUntilInstallerReady,
  markMacQuitAndInstallInFlight
} from './updater-mac-install'
import { registerAutoUpdaterHandlers } from './updater-events'
import {
  compareVersions,
  isBenignCheckFailure,
  isPrereleaseVersion,
  statusesEqual
} from './updater-fallback'
import { fetchNewerReleaseTag, getReleaseDownloadUrl } from './updater-prerelease-feed'
import { fetchNudge, shouldApplyNudge } from './updater-nudge'

const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const AUTO_UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000
const NUDGE_POLL_INTERVAL_MS = 30 * 60 * 1000
const NUDGE_ACTIVATION_COOLDOWN_MS = 5 * 60 * 1000
const QUIT_AND_INSTALL_DELAY_MS = 100

let mainWindowRef: BrowserWindow | null = null
let currentStatus: UpdateStatus = { state: 'idle' }
let userInitiatedCheck = false
let onBeforeQuitCleanup: (() => void) | null = null
let autoUpdaterInitialized = false
// Why: Shift-clicking "Check for Updates" opts the user into the RC release
// channel for the rest of this process. We switch to the GitHub provider
// with allowPrerelease=true so both the check AND any follow-up download
// resolve against the same (possibly prerelease) release manifest.
// Resetting only after the check would leave a downloaded RC pointing at a
// feed URL that no longer advertises it. See design comment in
// enableIncludePrerelease.
let includePrereleaseActive = false
let availableVersion: string | null = null
let availableReleaseUrl: string | null = null
let pendingCheckFailureKey: string | null = null
let pendingCheckFailurePromise: Promise<void> | null = null
let autoUpdateCheckTimer: ReturnType<typeof setTimeout> | null = null
let nudgeCheckTimer: ReturnType<typeof setTimeout> | null = null
let pendingQuitAndInstallTimer: ReturnType<typeof setTimeout> | null = null
let persistLastUpdateCheckAt: ((timestamp: number) => void) | null = null
let _getLastUpdateCheckAt: (() => number | null) | null = null
let backgroundCheckLaunchPending = false
let activeUpdateNudgeId: string | null = null
let awaitingNudgeCheckOutcome = false
let nudgeCheckInFlight = false
let lastNudgeCheckAt = 0

let _getPendingUpdateNudgeId: (() => string | null) | null = null
let _getDismissedUpdateNudgeId: (() => string | null) | null = null
let _setPendingUpdateNudgeId: ((id: string | null) => void) | null = null
let _setDismissedUpdateNudgeId: ((id: string | null) => void) | null = null
// Why: guards against duplicate download() calls when both the card and
// Settings trigger a download before the first download-progress event
// flips the status to 'downloading'.
let downloadInFlight = false
/** Guards against the macOS `activate` handler re-opening the old version
 *  while Squirrel's ShipIt is replacing the .app bundle. */
let quittingForUpdate = false

function clearAvailableUpdateContext(): void {
  availableVersion = null
  availableReleaseUrl = null
}

function clearPendingUpdateNudge(): void {
  activeUpdateNudgeId = null
  awaitingNudgeCheckOutcome = false
  _setPendingUpdateNudgeId?.(null)
}

function getPersistedPendingUpdateNudgeId(): string | null {
  return _getPendingUpdateNudgeId?.() ?? null
}

function decorateStatusWithActiveNudge(status: UpdateStatus): UpdateStatus {
  // Why: only actionable/error states carry the nudge marker so the renderer
  // can tell whether a dismiss should also acknowledge the campaign. Cycle-
  // boundary states (idle, checking, not-available) never need it.
  if (!activeUpdateNudgeId) {
    return status
  }
  if (status.state === 'idle' || status.state === 'checking' || status.state === 'not-available') {
    return status
  }
  return { ...status, activeNudgeId: activeUpdateNudgeId }
}

function sendStatus(status: UpdateStatus): void {
  if (awaitingNudgeCheckOutcome) {
    if (status.state === 'available') {
      awaitingNudgeCheckOutcome = false
    } else if (
      status.state === 'idle' ||
      status.state === 'not-available' ||
      status.state === 'error'
    ) {
      // Why: when a nudge-triggered check finds no update (or errors out),
      // move the campaign to dismissed so it doesn't re-fire on the next
      // poll cycle. Without this, a nudge whose version range includes
      // already-up-to-date users would loop every 30 minutes, each time
      // triggering a redundant checkForUpdates() and clearing the persisted
      // dismissedUpdateVersion.
      if (activeUpdateNudgeId) {
        _setDismissedUpdateNudgeId?.(activeUpdateNudgeId)
      }
      clearPendingUpdateNudge()
    }
  }

  const decoratedStatus = decorateStatusWithActiveNudge(status)

  // Why: reset the in-flight guard when the status moves past the
  // window where duplicate download() calls are possible.
  if (
    decoratedStatus.state === 'downloading' ||
    decoratedStatus.state === 'error' ||
    decoratedStatus.state === 'idle'
  ) {
    downloadInFlight = false
  }
  if (statusesEqual(currentStatus, decoratedStatus)) {
    return
  }
  currentStatus = decoratedStatus
  mainWindowRef?.webContents.send('updater:status', decoratedStatus)
}

function clearBackgroundCheckLaunchPending(): void {
  backgroundCheckLaunchPending = false
}

function sendErrorStatus(message: string, userInitiated?: boolean): void {
  if (
    currentStatus.state === 'error' &&
    currentStatus.message === message &&
    currentStatus.userInitiated === userInitiated
  ) {
    return
  }
  sendStatus({ state: 'error', message, userInitiated })
}

function getKnownReleaseUrl(): string | undefined {
  return availableReleaseUrl ?? undefined
}

function hasNewerDownloadedVersion(): boolean {
  return availableVersion !== null && compareVersions(availableVersion, app.getVersion()) > 0
}

function getPendingInstallVersion(): string {
  if (availableVersion) {
    return availableVersion
  }
  if (currentStatus.state === 'downloading' || currentStatus.state === 'downloaded') {
    return currentStatus.version
  }
  return ''
}

function performQuitAndInstall(): void {
  if (pendingQuitAndInstallTimer) {
    clearTimeout(pendingQuitAndInstallTimer)
    pendingQuitAndInstallTimer = null
  }

  markMacQuitAndInstallInFlight()

  // Set this BEFORE anything else so the `activate` handler in index.ts
  // won't re-open the old version while Squirrel's ShipIt is replacing
  // the .app bundle.  Without this guard the quit triggers window
  // destruction → BrowserWindow.getAllWindows().length === 0 → activate
  // fires → openMainWindow() resurrects the old process and ShipIt
  // either can't replace it or the user ends up on the old version.
  quittingForUpdate = true

  killAllPty()
  onBeforeQuitCleanup?.()

  for (const win of BrowserWindow.getAllWindows()) {
    win.removeAllListeners('close')
  }

  autoUpdater.quitAndInstall(false, true)
}

async function sendCheckFailureStatus(message: string, userInitiated?: boolean): Promise<void> {
  const failureKey = `${userInitiated ? 'user' : 'auto'}:${message}`
  if (pendingCheckFailureKey === failureKey && pendingCheckFailurePromise) {
    return pendingCheckFailurePromise
  }

  const handleFailure = async (): Promise<void> => {
    if (isBenignCheckFailure(message)) {
      // Why: release transition failures (missing latest.yml while a new
      // release is being published) and network blips are transient.  The
      // previous approach sent 'not-available' for user-initiated checks
      // during a release transition, which falsely told the user "you're
      // on the latest version" — the toast would flash and auto-dismiss,
      // hiding the fact that a newer release is mid-publish.  Now all
      // benign failures go to 'idle' uniformly: the toast controller
      // converts a user-initiated checking→idle transition into an honest
      // "currently rolling out" message, and a background retry is
      // always scheduled so the update notification arrives once the
      // release finishes.
      console.warn('[updater] benign check failure:', message)
      clearAvailableUpdateContext()
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      // Why: we intentionally do NOT call persistLastUpdateCheckAt here.
      // The check didn't truly complete (the manifest was unreachable due
      // to a release transition or network blip), so recording a timestamp
      // would suppress the next startup check and delay discovery of the
      // new version.
      sendStatus({ state: 'idle' })
      return
    }

    clearAvailableUpdateContext()
    persistLastUpdateCheckAt?.(Date.now())
    if (!userInitiated) {
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
    }
    sendErrorStatus(message, userInitiated)
  }

  pendingCheckFailureKey = failureKey
  pendingCheckFailurePromise = handleFailure().finally(() => {
    if (pendingCheckFailureKey === failureKey) {
      pendingCheckFailureKey = null
      pendingCheckFailurePromise = null
    }
  })
  return pendingCheckFailurePromise
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

function scheduleAutomaticUpdateCheck(delayMs: number): void {
  if (autoUpdateCheckTimer) {
    clearTimeout(autoUpdateCheckTimer)
  }
  autoUpdateCheckTimer = setTimeout(() => {
    // Why: Orca is often left running for days. A one-shot startup check means
    // users can miss fresh releases entirely, so we always keep the next
    // background attempt scheduled in the main process instead of tying checks
    // to relaunches or renderer lifetime.
    runBackgroundUpdateCheck()
  }, delayMs)
}

function recordCompletedUpdateCheck(): void {
  persistLastUpdateCheckAt?.(Date.now())
}

function shouldResolvePrereleaseFeed(): boolean {
  // Why: if the user Shift-clicked the menu to opt into RC this process, we've
  // already switched to the native github provider — leave that alone. The
  // atom-feed resolver only applies to users *running* a prerelease build on
  // the default generic feed.
  return !includePrereleaseActive && isPrereleaseVersion(app.getVersion())
}

async function pinPrereleaseFeed(): Promise<void> {
  // Why: for prerelease users we mine the atom feed ourselves and pin the
  // generic feed at /releases/download/<tag>/ so the follow-up manifest fetch
  // resolves against exactly that release. This handles BOTH RC→newer-RC and
  // RC→stable, which is what a prerelease user wants. We avoid the native
  // github provider because GitHubProvider.getLatestVersion() filters the feed
  // by channel — when currentChannel is "rc", stable releases get skipped and
  // the user never sees the GA (trapping them on the RC channel).
  //
  // If the resolver returns null (no newer release, or fetch failed), we fall
  // back to the default /releases/latest/download/ URL. In the "no newer"
  // case that feed will report the latest stable and compareVersions in the
  // 'update-available' handler will correctly mark it as not-available.
  const newerTag = await fetchNewerReleaseTag(app.getVersion())
  if (newerTag) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: getReleaseDownloadUrl(newerTag)
    })
  } else {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: 'https://github.com/stablyai/orca/releases/latest/download'
    })
  }
}

function runBackgroundUpdateCheck(
  nudgeId: string | null = getPersistedPendingUpdateNudgeId()
): void {
  if (backgroundCheckLaunchPending || currentStatus.state === 'checking') {
    return
  }
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available' })
    return
  }
  // Why: scope the nudge marker to the updater cycle being launched right now.
  // Setting it here, before any updater events or rejected promises can arrive,
  // prevents later ordinary checks from inheriting an older campaign id. Use
  // the persisted pending id for ordinary background checks so a nudge-driven
  // card can still be dismissed correctly after relaunch or a later 24h check.
  activeUpdateNudgeId = nudgeId
  // Why: autoUpdater.checkForUpdates() is async and 'checking-for-update'
  // arrives on a later tick, so a second focus/resume event can slip in before
  // currentStatus flips to 'checking'. Track the launch in memory to dedupe
  // that gap without persisting a successful-check timestamp before the result.
  backgroundCheckLaunchPending = true
  // Don't send 'checking' here — the 'checking-for-update' event handler does it,
  // and sending it from both places causes duplicate notifications (issue #35).
  const launch = (): Promise<unknown> => autoUpdater.checkForUpdates()
  const run = shouldResolvePrereleaseFeed() ? pinPrereleaseFeed().then(launch) : launch()
  void Promise.resolve(run).catch((err) => {
    backgroundCheckLaunchPending = false
    void sendCheckFailureStatus(String(err?.message ?? err))
  })
}

export function checkForUpdates(): void {
  runBackgroundUpdateCheck()
}

function enableIncludePrerelease(): void {
  if (includePrereleaseActive) {
    return
  }
  // Why: the default feed points at GitHub's /releases/latest/download/
  // manifest, which is scoped to the most recent non-prerelease release.
  // Switch to the native github provider with allowPrerelease so latest.yml
  // is sourced from the newest release on the repo regardless of the
  // prerelease flag. Staying on this feed for the rest of the process
  // keeps the download manifest consistent with the check result.
  autoUpdater.allowPrerelease = true
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'stablyai',
    repo: 'orca'
  })
  includePrereleaseActive = true
}

/** Menu-triggered check — delegates feedback to renderer toasts via userInitiated flag */
export function checkForUpdatesFromMenu(options?: { includePrerelease?: boolean }): void {
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available', userInitiated: true })
    return
  }

  if (options?.includePrerelease) {
    enableIncludePrerelease()
  }

  userInitiatedCheck = true
  // Why: a manual check is independent of any active nudge campaign. Reset the
  // nudge marker so the resulting status is not decorated with activeNudgeId,
  // which would cause a later dismiss to consume the campaign by accident.
  activeUpdateNudgeId = null
  // Don't send 'checking' here — the 'checking-for-update' event handler does it,
  // and sending it from both places causes duplicate notifications (issue #35).

  const launch = (): Promise<unknown> => autoUpdater.checkForUpdates()
  const run = shouldResolvePrereleaseFeed() ? pinPrereleaseFeed().then(launch) : launch()
  void Promise.resolve(run).catch((err) => {
    userInitiatedCheck = false
    void sendCheckFailureStatus(String(err?.message ?? err), true)
  })
}

export function isQuittingForUpdate(): boolean {
  return quittingForUpdate
}

export function quitAndInstall(): void {
  if (pendingQuitAndInstallTimer) {
    return
  }

  if (
    deferMacQuitUntilInstallerReady(
      currentStatus,
      hasNewerDownloadedVersion(),
      getPendingInstallVersion,
      sendStatus
    )
  ) {
    return
  }

  // Why: every renderer entrypoint reaches this IPC handler from an in-flight
  // click or toast callback. Deferring the actual quit here gives the renderer
  // a moment to flush dismissals/state updates before windows start closing,
  // and centralizing it avoids drift between the toast flow and settings UI.
  pendingQuitAndInstallTimer = setTimeout(() => {
    performQuitAndInstall()
  }, QUIT_AND_INSTALL_DELAY_MS)
}

async function checkForUpdateNudge(): Promise<void> {
  if (!app.isPackaged || is.dev) {
    return
  }
  if (nudgeCheckInFlight) {
    return
  }

  const now = Date.now()
  if (now - lastNudgeCheckAt < NUDGE_ACTIVATION_COOLDOWN_MS) {
    return
  }
  lastNudgeCheckAt = now

  nudgeCheckInFlight = true
  try {
    const nudge = await fetchNudge()
    if (!nudge) {
      return
    }

    if (currentStatus.state === 'checking' || currentStatus.state === 'downloading') {
      return
    }

    const appVersion = app.getVersion()
    const pendingUpdateNudgeId = _getPendingUpdateNudgeId?.() ?? null
    const dismissedUpdateNudgeId = _getDismissedUpdateNudgeId?.() ?? null

    if (
      shouldApplyNudge({
        nudge,
        appVersion,
        pendingUpdateNudgeId,
        dismissedUpdateNudgeId
      })
    ) {
      awaitingNudgeCheckOutcome = true
      _setPendingUpdateNudgeId?.(nudge.id)
      mainWindowRef?.webContents.send('updater:clearDismissal')
      runBackgroundUpdateCheck(nudge.id)
    }
  } finally {
    nudgeCheckInFlight = false
  }
}

function scheduleUpdateNudgeCheck(): void {
  if (nudgeCheckTimer) {
    clearTimeout(nudgeCheckTimer)
  }
  nudgeCheckTimer = setTimeout(() => {
    void checkForUpdateNudge()
    scheduleUpdateNudgeCheck()
  }, NUDGE_POLL_INTERVAL_MS)
}

export function dismissNudge(): void {
  const pendingId = activeUpdateNudgeId ?? _getPendingUpdateNudgeId?.() ?? null
  if (pendingId) {
    _setDismissedUpdateNudgeId?.(pendingId)
    clearPendingUpdateNudge()
  }
}

export function setupAutoUpdater(
  mainWindow: BrowserWindow,
  opts?: {
    getLastUpdateCheckAt?: () => number | null
    onBeforeQuit?: () => void
    setLastUpdateCheckAt?: (timestamp: number) => void
    getPendingUpdateNudgeId?: () => string | null
    getDismissedUpdateNudgeId?: () => string | null
    setPendingUpdateNudgeId?: (id: string | null) => void
    setDismissedUpdateNudgeId?: (id: string | null) => void
  }
): void {
  mainWindowRef = mainWindow
  onBeforeQuitCleanup = opts?.onBeforeQuit ?? null
  persistLastUpdateCheckAt = opts?.setLastUpdateCheckAt ?? null
  _getLastUpdateCheckAt = opts?.getLastUpdateCheckAt ?? null
  _getPendingUpdateNudgeId = opts?.getPendingUpdateNudgeId ?? null
  _getDismissedUpdateNudgeId = opts?.getDismissedUpdateNudgeId ?? null
  _setPendingUpdateNudgeId = opts?.setPendingUpdateNudgeId ?? null
  _setDismissedUpdateNudgeId = opts?.setDismissedUpdateNudgeId ?? null

  if (!app.isPackaged && !is.dev) {
    return
  }
  if (is.dev) {
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // Why: no Windows Authenticode certificate exists for this project.
  // electron-builder embeds the code-signing publisherName into the app's
  // bundled app-update.yml at build time. Versions that were incorrectly
  // signed with the macOS Apple Developer ID cert (issue #631) baked in a
  // publisherName whose chain Windows cannot validate, and even after the
  // CI fix the installed app's app-update.yml still contains the stale
  // publisherName. Skip Windows code signing verification — update
  // integrity is still guaranteed by the SHA-512 hash check in latest.yml.
  //
  // TODO: remove this override once a Windows Authenticode certificate is
  // purchased and WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD are added to CI.
  // At that point electron-builder will embed the correct publisherName
  // and the default verification should be re-enabled.
  if (process.platform === 'win32') {
    ;(autoUpdater as NsisUpdater).verifyUpdateCodeSignature = () => Promise.resolve(null)
  }

  // Use the generic provider with GitHub's /releases/latest/download/ URL so
  // electron-updater always fetches the manifest (latest-mac.yml, latest.yml,
  // latest-linux.yml) from the latest non-prerelease release. This sidesteps
  // the broken /releases/latest API endpoint (returns 406) and automatically
  // excludes RC/prerelease versions without client-side filtering.
  //
  // Why: for users already running a prerelease (e.g. 1.3.19-rc.6) we repin
  // this URL to a specific /releases/download/<tag>/ before each check — see
  // ensurePrereleaseFeedReady. That handles both RC→newer-RC AND RC→stable.
  // We keep the generic provider (rather than switching to electron-updater's
  // native github provider + allowPrerelease) because GitHubProvider filters
  // the atom feed by channel and would silently skip stable releases when the
  // running build is an RC — trapping the user on the RC channel.
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: 'https://github.com/stablyai/orca/releases/latest/download'
  })

  if (autoUpdaterInitialized) {
    return
  }
  autoUpdaterInitialized = true

  registerAutoUpdaterHandlers({
    clearAvailableUpdateContext,
    getCurrentStatus: () => currentStatus,
    getKnownReleaseUrl,
    getPendingInstallVersion,
    getUserInitiatedCheck: () => userInitiatedCheck,
    hasNewerDownloadedVersion,
    performQuitAndInstall,
    sendCheckFailureStatus,
    sendErrorStatus,
    recordCompletedUpdateCheck,
    sendStatus,
    scheduleAutomaticUpdateCheck,
    clearBackgroundCheckLaunchPending,
    setAvailableReleaseUrl: (releaseUrl) => {
      availableReleaseUrl = releaseUrl
    },
    setAvailableVersion: (version) => {
      availableVersion = version
    },
    setUserInitiatedCheck: (value) => {
      userInitiatedCheck = value
    }
  })

  void checkForUpdateNudge()
  scheduleUpdateNudgeCheck()

  const checkDailyOnWake = () => {
    void checkForUpdateNudge()
    if (
      backgroundCheckLaunchPending ||
      currentStatus.state === 'checking' ||
      currentStatus.state === 'downloading'
    ) {
      return
    }
    const lastCheck = _getLastUpdateCheckAt?.() ?? null
    const msSince = lastCheck === null ? Number.POSITIVE_INFINITY : Date.now() - lastCheck
    if (msSince >= AUTO_UPDATE_CHECK_INTERVAL_MS) {
      runBackgroundUpdateCheck()
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
    }
  }

  powerMonitor.on('resume', checkDailyOnWake)
  app.on('browser-window-focus', checkDailyOnWake)

  const lastUpdateCheckAt = opts?.getLastUpdateCheckAt?.() ?? null
  const msSinceLastCheck =
    lastUpdateCheckAt === null ? Number.POSITIVE_INFINITY : Date.now() - lastUpdateCheckAt

  if (msSinceLastCheck >= AUTO_UPDATE_CHECK_INTERVAL_MS) {
    runBackgroundUpdateCheck()
    scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
  } else {
    scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS - msSinceLastCheck)
  }
}

export function downloadUpdate(): void {
  if (downloadInFlight) {
    return
  }
  // Why: permit retry from 'error' when we still have a cached availableVersion —
  // a failed download leaves the status at 'error' but availableVersion intact,
  // and the error card's "Retry Download" button must be able to restart the
  // download. Without this, the button would appear to do nothing.
  const canStart =
    currentStatus.state === 'available' ||
    (currentStatus.state === 'error' && hasNewerDownloadedVersion())
  if (!canStart) {
    return
  }
  downloadInFlight = true
  beginMacUpdateDownload()
  autoUpdater.downloadUpdate().catch((err) => {
    downloadInFlight = false
    sendErrorStatus(String(err?.message ?? err))
  })
}
