import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import type { UpdateStatus } from '../shared/types'

let mainWindowRef: BrowserWindow | null = null
let currentStatus: UpdateStatus = { state: 'idle' }
let userInitiatedCheck = false

function sendStatus(status: UpdateStatus): void {
  currentStatus = status
  mainWindowRef?.webContents.send('updater:status', status)
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
    sendStatus({ state: 'error', message: String(err?.message ?? err) })
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
    sendStatus({ state: 'error', message: String(err?.message ?? err), userInitiated: true })
  })
}

export function quitAndInstall(): void {
  if (process.platform === 'darwin') {
    // On macOS, autoUpdater.quitAndInstall() calls app.exit() which bypasses
    // the normal quit lifecycle, causing the "quit unexpectedly" crash dialog.
    // Instead, use app.relaunch() + app.quit() which goes through the proper
    // lifecycle. autoInstallOnAppQuit (set in setupAutoUpdater) ensures the
    // update is applied during the quit process.
    app.relaunch()
    app.quit()
  } else {
    // On Windows/Linux, quitAndInstall works correctly with the NSIS installer.
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      win.removeAllListeners('close')
      win.destroy()
    }
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true)
    })
  }
}

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow

  if (!app.isPackaged && !is.dev) return
  if (is.dev) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Use allowPrerelease to bypass broken /releases/latest endpoint (returns 406)
  // and instead parse the version directly from the atom feed which works reliably.
  // This is safe since we don't publish prerelease versions.
  autoUpdater.allowPrerelease = true

  autoUpdater.on('checking-for-update', () => {
    sendStatus({ state: 'checking', userInitiated: userInitiatedCheck || undefined })
  })

  autoUpdater.on('update-available', (info) => {
    const wasUserInitiated = userInitiatedCheck
    userInitiatedCheck = false
    // Guard against re-downloading the version we're already running.
    // With allowPrerelease enabled, electron-updater may consider the
    // current version as an "available" update (same-version match).
    if (info.version === app.getVersion()) {
      sendStatus({ state: 'not-available', userInitiated: wasUserInitiated || undefined })
      return
    }
    sendStatus({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    const wasUserInitiated = userInitiatedCheck
    userInitiatedCheck = false
    sendStatus({ state: 'not-available', userInitiated: wasUserInitiated || undefined })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendStatus({ state: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    // Don't show the banner if the downloaded version is the one already running.
    if (info.version === app.getVersion()) {
      sendStatus({ state: 'not-available' })
      return
    }
    sendStatus({ state: 'downloaded', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    const wasUserInitiated = userInitiatedCheck
    userInitiatedCheck = false
    sendStatus({
      state: 'error',
      message: err?.message ?? 'Unknown error',
      userInitiated: wasUserInitiated || undefined
    })
  })

  autoUpdater.checkForUpdatesAndNotify()
}
