/* eslint-disable max-lines -- Why: notification IPC keeps permission, dispatch, custom sound asset, and sound-loading handlers colocated so renderer/main contracts stay auditable. */
import { app, BrowserWindow, Notification, ipcMain, shell } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, normalize } from 'node:path'
import beepSoundPath from '../../../resources/notification-sounds/beep.mp3?asset'
import blipSoundPath from '../../../resources/notification-sounds/blip.mp3?asset'
import blopSoundPath from '../../../resources/notification-sounds/blop.mp3?asset'
import bongSoundPath from '../../../resources/notification-sounds/bong.mp3?asset'
import clackSoundPath from '../../../resources/notification-sounds/clack.mp3?asset'
import dingSoundPath from '../../../resources/notification-sounds/ding.mp3?asset'
import sonarSoundPath from '../../../resources/notification-sounds/sonar.mp3?asset'
import thumpSoundPath from '../../../resources/notification-sounds/thump.mp3?asset'
import twoToneSoundPath from '../../../resources/notification-sounds/two-tone.mp3?asset'
import type { Store } from '../persistence'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationPermissionStatusResult,
  NotificationSettings,
  NotificationSoundDataResult
} from '../../shared/types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { buildNotificationOptions } from './notification-options'
import { parsePaneKey } from '../../shared/stable-pane-id'

const NOTIFICATION_COOLDOWN_MS = 5000
const NOTIFICATION_DISPLAY_CONFIRMATION_TIMEOUT_MS = 2500
const NOTIFICATION_RELEASE_FALLBACK_MS = 5 * 60 * 1000
const MAX_NOTIFICATION_SOUND_BYTES = 10 * 1024 * 1024
const MACOS_PACKAGED_BUNDLE_ID = 'com.stablyai.orca'
const MACOS_NOTIFICATION_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
const NOTIFICATION_SOUND_MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['.ogg', 'audio/ogg'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac']
])
const BUILT_IN_NOTIFICATION_SOUNDS: ReadonlyMap<string, string> = new Map([
  ['two-tone', twoToneSoundPath],
  ['bong', bongSoundPath],
  ['thump', thumpSoundPath],
  ['blip', blipSoundPath],
  ['sonar', sonarSoundPath],
  ['blop', blopSoundPath],
  ['ding', dingSoundPath],
  ['clack', clackSoundPath],
  ['beep', beepSoundPath]
])
type NotificationSoundId = NotificationSettings['customSoundId']

// Why: Electron Notification objects are normal JS objects — if the only
// reference is a local variable inside the ipcMain handler, the GC can
// collect them (and their click handlers) before the user interacts with
// the notification in macOS Notification Center. Prevent this by keeping a
// strong reference until the notification is clicked or closed.
const activeNotifications = new Set<Notification>()

function retainNotificationUntilRelease(
  notification: Notification,
  onRelease?: () => void
): () => void {
  activeNotifications.add(notification)
  let released = false
  let releaseTimer: ReturnType<typeof setTimeout> | null = null

  function release(): void {
    if (released) {
      return
    }
    released = true
    activeNotifications.delete(notification)
    notification.removeListener('close', release)
    if (releaseTimer) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
    onRelease?.()
  }

  notification.on('close', release)
  releaseTimer = setTimeout(release, NOTIFICATION_RELEASE_FALLBACK_MS)
  if (typeof releaseTimer.unref === 'function') {
    releaseTimer.unref()
  }

  return release
}

function getMacNotificationSettingsUrl(): string {
  const bundleId = process.env.ORCA_DEV_MACOS_BUNDLE_ID ?? MACOS_PACKAGED_BUNDLE_ID
  return `${MACOS_NOTIFICATION_SETTINGS_URL}?id=${encodeURIComponent(bundleId)}`
}

function openNotificationSystemSettings(): void {
  if (process.platform === 'darwin') {
    void shell.openExternal(getMacNotificationSettingsUrl())
  } else if (process.platform === 'win32') {
    void shell.openExternal('ms-settings:notifications')
  }
}

function getEffectiveNotificationSoundId(settings: NotificationSettings): NotificationSoundId {
  return settings.customSoundId ?? (settings.customSoundPath ? 'custom' : 'system')
}

function getSelectedNotificationSoundPath(settings: NotificationSettings): {
  path: string | null
  reason?: 'missing-path' | 'invalid-path' | 'unsupported-type'
} {
  const customSoundId = getEffectiveNotificationSoundId(settings)
  if (customSoundId === 'system') {
    return { path: null, reason: 'missing-path' }
  }
  if (customSoundId !== 'custom') {
    const builtInPath = BUILT_IN_NOTIFICATION_SOUNDS.get(customSoundId)
    return builtInPath ? { path: builtInPath } : { path: null, reason: 'missing-path' }
  }
  if (!settings.customSoundPath) {
    return { path: null, reason: 'missing-path' }
  }
  const normalizedPath = normalize(settings.customSoundPath)
  if (!isAbsolute(normalizedPath)) {
    return { path: null, reason: 'invalid-path' }
  }
  if (!NOTIFICATION_SOUND_MIME_BY_EXTENSION.has(extname(normalizedPath).toLowerCase())) {
    return { path: null, reason: 'unsupported-type' }
  }
  return { path: normalizedPath }
}

function waitForNotificationDisplay(notification: Notification): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (displayed: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      resolve(displayed)
    }

    notification.once('show', () => settle(true))
    notification.once('failed', () => settle(false))
    timer = setTimeout(() => settle(false), NOTIFICATION_DISPLAY_CONFIRMATION_TIMEOUT_MS)
  })
}

export function registerNotificationHandlers(store: Store, runtime?: OrcaRuntimeService): void {
  const recentNotifications = new Map<string, number>()

  ipcMain.removeHandler('notifications:openSystemSettings')
  ipcMain.removeHandler('notifications:getPermissionStatus')
  ipcMain.removeHandler('notifications:requestPermission')
  ipcMain.handle('notifications:openSystemSettings', (): void => {
    openNotificationSystemSettings()
  })

  // Why: Electron's main-process `Notification` class exposes no synchronous
  // way to read macOS auth status — the renderer-side `Notification.permission`
  // does not exist here. We expose what we can reliably observe: whether the
  // platform supports notifications and whether we've already kicked off the
  // first-permission prompt. A 'denied' OS result is invisible to us; the
  // dispatch path simply won't deliver in that case, which the user can
  // diagnose via the System Settings deep-link.
  const getPermissionStatus = (): NotificationPermissionStatusResult => ({
    supported: Notification.isSupported(),
    platform: process.platform,
    requested: store.getUI().notificationPermissionRequested === true
  })

  ipcMain.handle('notifications:getPermissionStatus', getPermissionStatus)
  ipcMain.handle('notifications:requestPermission', (): NotificationPermissionStatusResult => {
    triggerStartupNotificationRegistration(store)
    return getPermissionStatus()
  })

  ipcMain.removeHandler('notifications:dispatch')
  ipcMain.handle(
    'notifications:dispatch',
    (
      _event,
      args: NotificationDispatchRequest
    ): NotificationDispatchResult | Promise<NotificationDispatchResult> => {
      const settings = store.getSettings().notifications
      if (!settings.enabled) {
        return { delivered: false, reason: 'disabled' }
      }

      if (
        (args.source === 'agent-task-complete' && !settings.agentTaskComplete) ||
        (args.source === 'terminal-bell' && !settings.terminalBell)
      ) {
        return { delivered: false, reason: 'source-disabled' }
      }

      const browserWindow =
        BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null
      if (
        settings.suppressWhenFocused &&
        args.isActiveWorktree &&
        browserWindow &&
        browserWindow.isFocused()
      ) {
        return { delivered: false, reason: 'suppressed-focus' }
      }

      // Why: the Settings test button is an explicit user action, often
      // clicked repeatedly while tuning sounds, so it must bypass burst dedupe.
      if (args.source !== 'test') {
        // Dedupe by worktree, not by source — an agent finishing and a terminal bell
        // often fire within the same data chunk so only the first one should surface.
        const dedupeKey = args.worktreeId ?? args.worktreeLabel ?? 'global'
        const now = Date.now()
        const lastSentAt = recentNotifications.get(dedupeKey) ?? 0
        if (now - lastSentAt < NOTIFICATION_COOLDOWN_MS) {
          return { delivered: false, reason: 'cooldown' }
        }
        recentNotifications.set(dedupeKey, now)

        // Evict stale entries so the map doesn't grow unbounded.
        if (recentNotifications.size > 50) {
          for (const [key, ts] of recentNotifications) {
            if (now - ts >= NOTIFICATION_COOLDOWN_MS) {
              recentNotifications.delete(key)
            }
          }
        }
      }

      const notificationOptions = buildNotificationOptions(args)

      // Why: paired mobile clients should follow the same user-facing
      // notification gates as desktop delivery, while still working on hosts
      // where Electron native notifications are unavailable.
      if (runtime && args.source !== 'test') {
        runtime.dispatchMobileNotification({
          source: args.source,
          title: notificationOptions.title,
          body: notificationOptions.body,
          worktreeId: args.worktreeId
        })
      }

      if (!Notification.isSupported()) {
        return { delivered: false, reason: 'not-supported' }
      }

      if (getEffectiveNotificationSoundId(settings) !== 'system') {
        notificationOptions.silent = true
      } else if (process.platform === 'darwin') {
        // Why: macOS treats an unset notification sound as silent. When Orca is
        // using the OS sound, ask Electron for the default notification sound.
        notificationOptions.sound = 'default'
      }
      const notification = new Notification(notificationOptions)

      // Why: prevent GC from collecting the notification (and its click
      // handler) while it's still visible in macOS Notification Center.
      let clickHandler: (() => void) | null = null
      const release = retainNotificationUntilRelease(notification, () => {
        if (clickHandler) {
          notification.removeListener('click', clickHandler)
          clickHandler = null
        }
      })

      // Why: clicking a notification should bring Orca to the foreground and
      // switch to the worktree/pane that triggered it. Worktree activation owns
      // repo/sidebar state; the optional focusTerminal follow-up uses the stable
      // pane leaf id so split-pane notifications land on the exact pane.
      // Why: worktreeId is formatted as "repoId::worktreePath".  If the
      // separator is missing we cannot reliably extract a repoId, so skip
      // the click-to-navigate binding — the notification still fires but
      // clicking it will not attempt to switch to an unknown worktree.
      if (args.worktreeId && args.worktreeId.includes('::')) {
        const repoId = getRepoIdFromWorktreeId(args.worktreeId)
        clickHandler = () => {
          release()
          const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
          if (!win) {
            return
          }
          if (process.platform === 'darwin') {
            app.focus({ steal: true })
          }
          if (win.isMinimized()) {
            win.restore()
          }
          win.focus()
          win.webContents.send('ui:activateWorktree', {
            repoId,
            worktreeId: args.worktreeId
          })
          const paneTarget = args.paneKey ? parsePaneKey(args.paneKey) : null
          if (paneTarget) {
            win.webContents.send('ui:focusTerminal', {
              tabId: paneTarget.tabId,
              worktreeId: args.worktreeId,
              leafId: paneTarget.leafId,
              ackPaneKeyOnSuccess: args.paneKey,
              flashFocusedPane: true,
              scrollToBottomIfOutputSinceLastView: true
            })
          }
        }
        notification.on('click', clickHandler)
      }

      const displayConfirmation = args.requireDisplayConfirmation
        ? waitForNotificationDisplay(notification)
        : null
      notification.show()

      if (displayConfirmation) {
        return displayConfirmation.then((displayed) => {
          if (!displayed) {
            release()
            return { delivered: false, reason: 'not-displayed' }
          }
          return { delivered: true }
        })
      }

      return { delivered: true }
    }
  )

  // Why: the preload caches the decoded blob keyed by path. Returning just
  // the validated path lets it skip the 10MB IPC round-trip on every dispatch
  // when the user's selection hasn't changed — terminal-bell bursts can fire
  // many notifications in seconds.
  ipcMain.removeHandler('notifications:resolveSoundPath')
  ipcMain.handle(
    'notifications:resolveSoundPath',
    ():
      | { ok: true; path: string }
      | { ok: false; reason: 'missing-path' | 'invalid-path' | 'unsupported-type' } => {
      const selectedSound = getSelectedNotificationSoundPath(store.getSettings().notifications)
      if (!selectedSound.path) {
        return { ok: false, reason: selectedSound.reason ?? 'missing-path' }
      }
      const normalizedPath = normalize(selectedSound.path)
      if (!NOTIFICATION_SOUND_MIME_BY_EXTENSION.has(extname(normalizedPath).toLowerCase())) {
        return { ok: false, reason: 'unsupported-type' }
      }
      return { ok: true, path: normalizedPath }
    }
  )

  ipcMain.removeHandler('notifications:loadSound')
  ipcMain.handle('notifications:loadSound', async (): Promise<NotificationSoundDataResult> => {
    const selectedSound = getSelectedNotificationSoundPath(store.getSettings().notifications)
    if (!selectedSound.path) {
      return { ok: false, reason: selectedSound.reason ?? 'missing-path' }
    }

    const normalizedPath = normalize(selectedSound.path)

    const mimeType = NOTIFICATION_SOUND_MIME_BY_EXTENSION.get(extname(normalizedPath).toLowerCase())
    if (!mimeType) {
      return { ok: false, reason: 'unsupported-type' }
    }

    try {
      const fileStat = await stat(normalizedPath)
      if (!fileStat.isFile()) {
        return { ok: false, reason: 'invalid-path' }
      }
      if (fileStat.size > MAX_NOTIFICATION_SOUND_BYTES) {
        return { ok: false, reason: 'too-large' }
      }

      const data = await readFile(normalizedPath)
      return { ok: true, data: new Uint8Array(data), mimeType, path: normalizedPath }
    } catch {
      return { ok: false, reason: 'read-failed' }
    }
  })
}

/**
 * On first launch, when macOS notification permission is 'not-determined',
 * show a welcome notification to trigger the system permission dialog.
 *
 * Why: macOS requires at least one notification attempt before the system
 * will prompt the user to allow/deny. Doing this at startup with meaningful
 * content avoids a confusing blank notification later. The notification is
 * closed shortly after to avoid lingering in Notification Center.
 */
export function triggerStartupNotificationRegistration(store: Store): void {
  if (process.platform !== 'darwin' || !Notification.isSupported()) {
    return
  }
  // Why: only fire once per install — not on every launch where status stays
  // not-determined (e.g. if the user dismisses the macOS dialog without choosing).
  const ui = store.getUI()
  if (ui.notificationPermissionRequested) {
    return
  }
  store.updateUI({ notificationPermissionRequested: true })

  const notification = new Notification({
    title: 'Orca is ready to notify you',
    body: 'Allow notifications so Orca can alert you when agents finish or terminals need attention.'
  })

  // Why: prevent GC from collecting the notification (and its click handler)
  // while it's still visible in macOS Notification Center.
  activeNotifications.add(notification)

  let handled = false
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null

  function clearStartupTimers(): void {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    if (fallbackTimer) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  }

  function cleanup(): void {
    if (handled) {
      return
    }
    handled = true
    clearStartupTimers()
    activeNotifications.delete(notification)
    notification.removeListener('click', onClick)
    notification.removeListener('show', onShow)
    notification.close()
  }

  // Why: clicking the startup notification should take the user to macOS
  // Notification Settings so they can verify/enable notifications for Orca.
  // Without this, the notification reads like an actionable prompt ("Allow
  // notifications…") but clicking it does nothing, which is confusing.
  function onClick(): void {
    cleanup()
    openNotificationSystemSettings()
  }

  function onShow(): void {
    // Why: close after a short delay so the notification doesn't linger in
    // Notification Center. The macOS permission dialog is a system-level sheet
    // that appears independently and is not dismissed by closing this notification.
    closeTimer = setTimeout(cleanup, 8000)
    if (typeof closeTimer.unref === 'function') {
      closeTimer.unref()
    }
  }

  notification.on('click', onClick)
  notification.on('show', onShow)

  // Fallback in case macOS doesn't fire the 'show' event (e.g. user denies).
  fallbackTimer = setTimeout(cleanup, 10_000)
  if (typeof fallbackTimer.unref === 'function') {
    fallbackTimer.unref()
  }

  notification.show()
}
