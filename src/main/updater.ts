import { app, BrowserWindow, shell } from 'electron'
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
import {
  compareVersions,
  findFallbackReleaseVersion,
  isBenignCheckFailure,
  isGitHubReleaseTransitionFailure,
  statusesEqual
} from './updater-fallback'

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
      if (isGitHubReleaseTransitionFailure(message.toLowerCase())) {
        try {
          const fallbackRelease = await findFallbackReleaseVersion()
          if (fallbackRelease) {
            console.warn(
              '[updater] using fallback GitHub release during release transition:',
              fallbackRelease.version
            )
            availableVersion = fallbackRelease.version
            availableReleaseUrl = fallbackRelease.releaseUrl
            persistLastUpdateCheckAt?.(Date.now())
            if (!userInitiated) {
              scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
            }
            sendStatus({
              state: 'available',
              version: fallbackRelease.version,
              releaseUrl: fallbackRelease.releaseUrl,
              manualDownloadUrl: fallbackRelease.manualDownloadUrl
            })
            return
          }
        } catch (fallbackError) {
          console.warn(
            '[updater] fallback GitHub release lookup failed:',
            String((fallbackError as Error)?.message ?? fallbackError)
          )
        }

        // The fallback confirmed there is no published version newer than the
        // current one (the only "newer" entry is a draft mid-release).  Tell
        // the user they're up-to-date so clicking "Check for Updates" doesn't
        // appear to silently do nothing.
        if (userInitiated) {
          clearAvailableUpdateContext()
          persistLastUpdateCheckAt?.(Date.now())
          sendStatus({ state: 'not-available', userInitiated: true })
          return
        }
      }

      console.warn('[updater] benign check failure:', message)
      clearAvailableUpdateContext()
      if (!userInitiated) {
        scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS)
      }
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
  // Use allowPrerelease to bypass broken /releases/latest endpoint (returns 406)
  // and instead parse the version directly from the atom feed which works reliably.
  // This is safe since we don't publish prerelease versions.
  autoUpdater.allowPrerelease = true

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
  if (currentStatus.manualDownloadUrl) {
    shell.openExternal(currentStatus.manualDownloadUrl).catch((err) => {
      sendErrorStatus(String(err?.message ?? err))
    })
    return
  }
  beginMacUpdateDownload()
  autoUpdater.downloadUpdate().catch((err) => {
    sendErrorStatus(String(err?.message ?? err))
  })
}
