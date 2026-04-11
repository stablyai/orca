import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import type { UpdateStatus } from '../shared/types'
import { killAllPty } from './ipc/pty'
import {
  beginMacUpdateDownload,
  deferMacQuitUntilInstallerReady,
  markMacQuitAndInstallInFlight
} from './updater-mac-install'
import { registerAutoUpdaterHandlers } from './updater-events'
import { compareVersions, isBenignCheckFailure, statusesEqual } from './updater-fallback'

const AUTO_UPDATE_CHECK_INTERVAL_MS = 36 * 60 * 60 * 1000
const AUTO_UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000
const QUIT_AND_INSTALL_DELAY_MS = 100

let mainWindowRef: BrowserWindow | null = null
let currentStatus: UpdateStatus = { state: 'idle' }
let userInitiatedCheck = false
let onBeforeQuitCleanup: (() => void) | null = null
let autoUpdaterInitialized = false
let availableVersion: string | null = null
let availableReleaseUrl: string | null = null
let pendingCheckFailureKey: string | null = null
let pendingCheckFailurePromise: Promise<void> | null = null
let autoUpdateCheckTimer: ReturnType<typeof setTimeout> | null = null
let pendingQuitAndInstallTimer: ReturnType<typeof setTimeout> | null = null
let persistLastUpdateCheckAt: ((timestamp: number) => void) | null = null
/** Guards against the macOS `activate` handler re-opening the old version
 *  while Squirrel's ShipIt is replacing the .app bundle. */
let quittingForUpdate = false

function clearAvailableUpdateContext(): void {
  availableVersion = null
  availableReleaseUrl = null
}

function sendStatus(status: UpdateStatus): void {
  if (statusesEqual(currentStatus, status)) {
    return
  }
  currentStatus = status
  mainWindowRef?.webContents.send('updater:status', status)
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

function runBackgroundUpdateCheck(): void {
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available' })
    return
  }
  // Don't send 'checking' here — the 'checking-for-update' event handler does it,
  // and sending it from both places causes duplicate notifications (issue #35).
  autoUpdater.checkForUpdates().catch((err) => {
    void sendCheckFailureStatus(String(err?.message ?? err))
  })
}

export function checkForUpdates(): void {
  runBackgroundUpdateCheck()
}

/** Menu-triggered check — delegates feedback to renderer toasts via userInitiated flag */
export function checkForUpdatesFromMenu(): void {
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available', userInitiated: true })
    return
  }

  userInitiatedCheck = true
  // Don't send 'checking' here — the 'checking-for-update' event handler does it,
  // and sending it from both places causes duplicate notifications (issue #35).

  autoUpdater.checkForUpdates().catch((err) => {
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

export function setupAutoUpdater(
  mainWindow: BrowserWindow,
  opts?: {
    getLastUpdateCheckAt?: () => number | null
    onBeforeQuit?: () => void
    setLastUpdateCheckAt?: (timestamp: number) => void
  }
): void {
  mainWindowRef = mainWindow
  onBeforeQuitCleanup = opts?.onBeforeQuit ?? null
  persistLastUpdateCheckAt = opts?.setLastUpdateCheckAt ?? null

  if (!app.isPackaged && !is.dev) {
    return
  }
  if (is.dev) {
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // Use the generic provider with GitHub's /releases/latest/download/ URL so
  // electron-updater always fetches the manifest (latest-mac.yml, latest.yml,
  // latest-linux.yml) from the latest non-prerelease release. This sidesteps
  // the broken /releases/latest API endpoint (returns 406) and automatically
  // excludes RC/prerelease versions without client-side filtering.
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
  if (currentStatus.state !== 'available') {
    return
  }
  beginMacUpdateDownload()
  autoUpdater.downloadUpdate().catch((err) => {
    sendErrorStatus(String(err?.message ?? err))
  })
}
