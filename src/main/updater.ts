import { app, BrowserWindow, autoUpdater as nativeUpdater, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import type { UpdateStatus } from '../shared/types'
import { killAllPty } from './ipc/pty'
import { findFallbackReleaseVersion, isGitHubReleaseTransitionFailure } from './updater-fallback'

let mainWindowRef: BrowserWindow | null = null
let currentStatus: UpdateStatus = { state: 'idle' }
let userInitiatedCheck = false
let onBeforeQuitCleanup: (() => void) | null = null
let autoUpdaterInitialized = false
let availableVersion: string | null = null
let availableReleaseUrl: string | null = null
let pendingCheckFailureKey: string | null = null
let pendingCheckFailurePromise: Promise<void> | null = null
/** Whether Squirrel.Mac has finished downloading the update from the localhost proxy. */
let squirrelReady = false

function clearAvailableUpdateContext(): void {
  availableVersion = null
  availableReleaseUrl = null
}

function statusesEqual(left: UpdateStatus, right: UpdateStatus): boolean {
  switch (left.state) {
    case 'idle':
      return right.state === 'idle'
    case 'checking':
      return right.state === 'checking' && left.userInitiated === right.userInitiated
    case 'not-available':
      return right.state === 'not-available' && left.userInitiated === right.userInitiated
    case 'available':
      return (
        right.state === 'available' &&
        left.version === right.version &&
        left.releaseUrl === right.releaseUrl &&
        left.manualDownloadUrl === right.manualDownloadUrl
      )
    case 'downloading':
      return (
        right.state === 'downloading' &&
        left.version === right.version &&
        left.percent === right.percent
      )
    case 'downloaded':
      return (
        right.state === 'downloaded' &&
        left.version === right.version &&
        left.releaseUrl === right.releaseUrl
      )
    case 'error':
      return (
        right.state === 'error' &&
        left.message === right.message &&
        left.userInitiated === right.userInitiated
      )
  }
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

function isBenignCheckFailure(message: string): boolean {
  const normalizedMessage = message.toLowerCase()

  if (normalizedMessage.includes('net::err_failed')) {
    return true
  }

  // GitHub releases can briefly be in a half-published state while the
  // release workflow is creating a draft and uploading update metadata.
  // During that window electron-updater may fail the check even though
  // nothing is wrong on the client side.
  return (
    isGitHubReleaseTransitionFailure(normalizedMessage) ||
    normalizedMessage.includes('no published versions on github')
  )
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
          sendStatus({ state: 'not-available', userInitiated: true })
          return
        }
      }

      console.warn('[updater] benign check failure:', message)
      clearAvailableUpdateContext()
      sendStatus({ state: 'idle' })
      return
    }

    clearAvailableUpdateContext()
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

export function checkForUpdates(): void {
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

export function quitAndInstall(): void {
  killAllPty()
  onBeforeQuitCleanup?.()

  // Remove close listeners so windows don't block the quit, but do NOT
  // destroy them yet. On macOS, MacUpdater.quitAndInstall() delegates to
  // Squirrel.Mac's nativeUpdater.quitAndInstall() which handles quitting
  // the app. If we destroy windows before Squirrel is ready, the app ends
  // up with zero windows and the dock "activate" handler re-opens the old
  // version instead of actually updating.
  for (const win of BrowserWindow.getAllWindows()) {
    win.removeAllListeners('close')
  }

  autoUpdater.quitAndInstall(false, true)
}

export function setupAutoUpdater(
  mainWindow: BrowserWindow,
  opts?: { onBeforeQuit?: () => void }
): void {
  mainWindowRef = mainWindow
  onBeforeQuitCleanup = opts?.onBeforeQuit ?? null

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

  // On macOS, electron-updater's MacUpdater downloads the ZIP from GitHub,
  // then serves it to Squirrel.Mac via a localhost proxy. The electron-updater
  // 'update-downloaded' event fires BEFORE Squirrel finishes its download.
  // Track Squirrel readiness so we don't show "ready to install" prematurely.
  if (process.platform === 'darwin') {
    nativeUpdater.on('update-downloaded', () => {
      squirrelReady = true
      // If we were holding the 'downloaded' status, send it now
      if (availableVersion && availableVersion !== app.getVersion()) {
        sendStatus({
          state: 'downloaded',
          version: availableVersion,
          releaseUrl: getKnownReleaseUrl()
        })
      }
    })
  }

  autoUpdater.on('checking-for-update', () => {
    clearAvailableUpdateContext()
    sendStatus({ state: 'checking', userInitiated: userInitiatedCheck || undefined })
  })

  autoUpdater.on('update-available', (info) => {
    const wasUserInitiated = userInitiatedCheck
    userInitiatedCheck = false
    // Guard against re-downloading the version we're already running.
    // With allowPrerelease enabled, electron-updater may consider the
    // current version as an "available" update (same-version match).
    if (info.version === app.getVersion()) {
      clearAvailableUpdateContext()
      sendStatus({ state: 'not-available', userInitiated: wasUserInitiated || undefined })
      return
    }
    availableVersion = info.version
    availableReleaseUrl = null
    sendStatus({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    const wasUserInitiated = userInitiatedCheck
    userInitiatedCheck = false
    clearAvailableUpdateContext()
    sendStatus({ state: 'not-available', userInitiated: wasUserInitiated || undefined })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus({
      state: 'downloading',
      percent: Math.round(progress.percent),
      version: availableVersion ?? ''
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    // Don't show the banner if the downloaded version is the one already running.
    if (info.version === app.getVersion()) {
      clearAvailableUpdateContext()
      sendStatus({ state: 'not-available' })
      return
    }
    // On macOS, defer the 'downloaded' status until Squirrel.Mac has finished
    // processing the update via the localhost proxy. On other platforms,
    // the update is ready immediately after electron-updater downloads it.
    if (process.platform === 'darwin' && !squirrelReady) {
      // Squirrel is still processing — show download at 100% while waiting.
      // The nativeUpdater 'update-downloaded' handler above will send the
      // real 'downloaded' status when Squirrel finishes.
      sendStatus({ state: 'downloading', percent: 100, version: info.version })
      return
    }
    sendStatus({ state: 'downloaded', version: info.version, releaseUrl: getKnownReleaseUrl() })
  })

  autoUpdater.on('error', (err) => {
    const wasUserInitiated = userInitiatedCheck
    userInitiatedCheck = false
    const message = err?.message ?? 'Unknown error'
    if (currentStatus.state === 'checking') {
      void sendCheckFailureStatus(message, wasUserInitiated || undefined)
      return
    }
    sendErrorStatus(message, wasUserInitiated || undefined)
  })

  autoUpdater.checkForUpdates().catch((err) => {
    // Startup check — don't bother the user, but log for diagnostics
    console.error('[updater] startup check failed:', err?.message ?? err)
  })
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
  squirrelReady = false
  autoUpdater.downloadUpdate().catch((err) => {
    sendErrorStatus(String(err?.message ?? err))
  })
}
