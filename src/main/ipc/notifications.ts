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
  NotificationDeliveryProbeResult,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationDismissResult,
  NotificationPermissionStatusResult,
  NotificationSettings,
  NotificationSoundDataResult
} from '../../shared/types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { buildNotificationOptions } from './notification-options'
import { readNotificationAuthorizationStatus } from './notification-authorization-status'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { setTrayAttention } from '../tray/system-tray'
import { isMainWindowVisible } from '../window/main-window-visibility'

const NOTIFICATION_COOLDOWN_MS = 5000
const MAX_RECENT_NOTIFICATION_KEYS = 50
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
const activeNotificationsById = new Map<
  string,
  { notification: Notification; release: () => void }
>()

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

const NOTIFICATION_PROBE_RESULT_TIMEOUT_MS = 3000
const NOTIFICATION_PROBE_BANNER_CLOSE_DELAY_MS = 4000

// Why: Electron has no API to read macOS UNUserNotificationCenter
// authorization, so the freshest signal we have is what happened to the last
// notification we scheduled. Session-scoped on purpose: OS-level permission
// can change between runs, and a stale positive renders a false green card.
let lastObservedDeliveryOutcome: 'delivered' | 'failed' | null = null
let deliveryProbeInFlight: Promise<NotificationDeliveryProbeResult> | null = null
// Why: firing one probe notification is what instantiates Electron's
// presenter and pops the macOS permission dialog. Once per session is enough
// while the authorization readout reports the decision as pending.
let permissionDialogTriggeredThisSession = false

/**
 * Fallback signal for hosts without the native helper. Schedules a silent
 * probe notification and reports whether macOS accepted it. 'failed' means
 * the request was rejected (permission denied, or an unsigned build). On a
 * fresh install the probe also instantiates Electron's notification
 * presenter, which is what makes macOS pop the "Allow notifications?" dialog.
 *
 * Known ambiguity with no public API to resolve it (verified on macOS 26):
 * while the dialog is unanswered — and when notifications are toggled off in
 * System Settings after being authorized — macOS still accepts requests and
 * silently swallows them, so 'delivered' can over-report. 'failed' fires for
 * hard rejections (unsigned builds, dialog-level denial). The bundled
 * notification-status helper exists precisely to avoid this ambiguity.
 */
function probeNotificationDelivery(): Promise<NotificationDeliveryProbeResult> {
  if (deliveryProbeInFlight) {
    return deliveryProbeInFlight
  }
  permissionDialogTriggeredThisSession = true

  const probe = new Notification({
    title: 'Orca notifications are on',
    body: 'Orca will alert you when agents finish or terminals need attention.',
    silent: true
  })
  activeNotifications.add(probe)

  deliveryProbeInFlight = new Promise<NotificationDeliveryProbeResult>((resolve) => {
    let settled = false
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    function releaseProbe(): void {
      activeNotifications.delete(probe)
      probe.removeListener('show', onShow)
      probe.removeListener('failed', onFailed)
      probe.close()
    }

    function settle(state: 'delivered' | 'blocked'): void {
      if (settled) {
        return
      }
      settled = true
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
      lastObservedDeliveryOutcome = state === 'delivered' ? 'delivered' : 'failed'
      resolve({ state, authoritative: false })
    }

    function onShow(): void {
      settle('delivered')
      // Why: when delivery works the probe banner is visible, so it doubles
      // as the user-facing confirmation — let it linger briefly instead of
      // vanishing the instant it appears.
      const closeTimer = setTimeout(releaseProbe, NOTIFICATION_PROBE_BANNER_CLOSE_DELAY_MS)
      if (typeof closeTimer.unref === 'function') {
        closeTimer.unref()
      }
    }

    function onFailed(_event: unknown, _error?: string): void {
      // Why: a rejected probe is an expected outcome (denied permission), not
      // an anomaly — logging it would spam the console on every poll while
      // the onboarding card waits for the user to allow notifications.
      settle('blocked')
      releaseProbe()
    }

    probe.once('show', onShow)
    probe.once('failed', onFailed)
    // Why: don't record a 'failed' outcome on timeout — a missing callback is
    // ambiguous, while the 'failed' event is a definitive rejection.
    timeoutTimer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve({ state: 'blocked', authoritative: false })
        releaseProbe()
      }
    }, NOTIFICATION_PROBE_RESULT_TIMEOUT_MS)
    if (typeof timeoutTimer.unref === 'function') {
      timeoutTimer.unref()
    }

    probe.show()
  }).finally(() => {
    deliveryProbeInFlight = null
  })

  return deliveryProbeInFlight
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

    function cleanup(): void {
      notification.removeListener('show', onShow)
      notification.removeListener('failed', onFailed)
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }

    function settle(displayed: boolean): void {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(displayed)
    }

    function onShow(): void {
      settle(true)
    }

    function onFailed(): void {
      settle(false)
    }

    notification.once('show', onShow)
    notification.once('failed', onFailed)
    timer = setTimeout(() => settle(false), NOTIFICATION_DISPLAY_CONFIRMATION_TIMEOUT_MS)
  })
}

function logNativeNotificationFailure(context: string, error?: string): void {
  console.warn(
    `[notifications] ${context} notification failed to show${error ? `: ${error}` : '.'}`
  )
}

function pruneRecentNotifications(recentNotifications: Map<string, number>, now: number): void {
  if (recentNotifications.size <= MAX_RECENT_NOTIFICATION_KEYS) {
    return
  }

  for (const [key, ts] of recentNotifications) {
    if (now - ts >= NOTIFICATION_COOLDOWN_MS) {
      recentNotifications.delete(key)
    }
  }

  while (recentNotifications.size > MAX_RECENT_NOTIFICATION_KEYS) {
    const oldest = recentNotifications.keys().next()
    if (oldest.done) {
      break
    }
    recentNotifications.delete(oldest.value)
  }
}

function reserveNotificationCooldown(
  recentNotifications: Map<string, number>,
  dedupeKey: string,
  now: number
): boolean {
  const lastSentAt = recentNotifications.get(dedupeKey) ?? 0
  if (now - lastSentAt < NOTIFICATION_COOLDOWN_MS) {
    return false
  }
  recentNotifications.delete(dedupeKey)
  recentNotifications.set(dedupeKey, now)
  pruneRecentNotifications(recentNotifications, now)
  return true
}

export function registerNotificationHandlers(store: Store, runtime?: OrcaRuntimeService): void {
  const recentDesktopNotifications = new Map<string, number>()
  const recentMobileNotifications = new Map<string, number>()
  // Why: handler registration marks a fresh session — permission evidence
  // from a previous registration must not leak into the new one.
  lastObservedDeliveryOutcome = null
  deliveryProbeInFlight = null
  permissionDialogTriggeredThisSession = false

  ipcMain.removeHandler('notifications:openSystemSettings')
  ipcMain.removeHandler('notifications:getPermissionStatus')
  ipcMain.removeHandler('notifications:probeDelivery')
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
  ipcMain.handle(
    'notifications:probeDelivery',
    async (_event, args?: { force?: boolean }): Promise<NotificationDeliveryProbeResult> => {
      // Why: macOS-only. Windows/Linux have no equivalent first-use permission
      // dialog, so the onboarding card that consumes this never renders there.
      if (process.platform !== 'darwin' || !Notification.isSupported()) {
        return { state: 'unsupported', authoritative: false }
      }
      // Why: probes (and the native helper's first-launch path) surface the
      // macOS permission dialog — mark the one-shot startup registration as
      // done so it can't fire a second prompt later.
      if (store.getUI().notificationPermissionRequested !== true) {
        store.updateUI({ notificationPermissionRequested: true })
      }
      // Preferred source: the bundled helper reads the real
      // UNUserNotificationCenter authorization. Silent, so polling with it
      // tracks System Settings changes live without flashing banners.
      const authorization = await readNotificationAuthorizationStatus()
      if (authorization === 'authorized') {
        lastObservedDeliveryOutcome = 'delivered'
        return { state: 'delivered', authoritative: true }
      }
      if (authorization === 'denied') {
        lastObservedDeliveryOutcome = 'failed'
        return { state: 'blocked', authoritative: true }
      }
      if (authorization === 'not-determined') {
        // Why: the dialog only appears once something asks — fire a single
        // probe per session to trigger it, then report the pending decision.
        if (!permissionDialogTriggeredThisSession) {
          void probeNotificationDelivery()
        }
        return { state: 'awaiting-decision', authoritative: true }
      }
      // Helper unavailable ('unknown' status is also unusable evidence):
      // fall back to scheduling-based probes with session caching, which
      // avoids repeated probe banners when delivery works.
      if (!args?.force && lastObservedDeliveryOutcome !== null) {
        return {
          state: lastObservedDeliveryOutcome === 'delivered' ? 'delivered' : 'blocked',
          authoritative: false
        }
      }
      return probeNotificationDelivery()
    }
  )

  ipcMain.removeHandler('notifications:dismiss')
  ipcMain.handle('notifications:dismiss', (_event, ids: string[]): NotificationDismissResult => {
    const uniqueIds = Array.from(
      new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))
    )
    let dismissed = 0
    for (const id of uniqueIds) {
      const entry = activeNotificationsById.get(id)
      if (entry) {
        entry.notification.close()
        entry.release()
        dismissed += 1
      }
      runtime?.dismissMobileNotification(id)
    }
    return { dismissed }
  })

  ipcMain.removeHandler('notifications:dispatch')
  ipcMain.handle(
    'notifications:dispatch',
    (
      _event,
      args: NotificationDispatchRequest
    ): NotificationDispatchResult | Promise<NotificationDispatchResult> => {
      // Why: a terminal bell or agent completion that arrives while the window
      // is minimized/hidden lights the tray attention dot — a passive cue that
      // clears on window show/restore (see index.ts). Placed before the
      // focus-suppression, cooldown, and enabled gates below so those do not
      // hold back the dot. It rides the notification dispatch, so it follows the
      // renderer's per-source decision to notify: bells always reach here, while
      // an agent completion is suppressed upstream when its notification is
      // disabled. Tray exists only on Windows, so setTrayAttention no-ops
      // elsewhere.
      if (args.source === 'agent-task-complete' || args.source === 'terminal-bell') {
        const activeWindow = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null
        if (!isMainWindowVisible(activeWindow)) {
          setTrayAttention(true)
        }
      }

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

      const notificationOptions = buildNotificationOptions(args)

      // Why: desktop focus only means this computer has the worktree visible;
      // the paired phone may be locked or elsewhere and still needs the alert.
      if (runtime && args.source !== 'test') {
        const dedupeKey = args.worktreeId ?? args.worktreeLabel ?? 'global'
        if (reserveNotificationCooldown(recentMobileNotifications, dedupeKey, Date.now())) {
          runtime.dispatchMobileNotification({
            type: 'notification',
            source: args.source,
            title: notificationOptions.title,
            body: notificationOptions.body,
            worktreeId: args.worktreeId,
            ...(args.notificationId ? { notificationId: args.notificationId } : {})
          })
        }
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
        if (!reserveNotificationCooldown(recentDesktopNotifications, dedupeKey, Date.now())) {
          return { delivered: false, reason: 'cooldown' }
        }
      }

      if (!Notification.isSupported()) {
        return { delivered: false, reason: 'not-supported' }
      }

      function deliverNativeNotification():
        | NotificationDispatchResult
        | Promise<NotificationDispatchResult> {
        if (getEffectiveNotificationSoundId(settings) !== 'system') {
          notificationOptions.silent = true
        } else if (process.platform === 'darwin') {
          // Why: macOS treats an unset notification sound as silent. When Orca is
          // using the OS sound, ask Electron for the default notification sound.
          notificationOptions.sound = 'default'
        }
        const notification = new Notification(notificationOptions)
        if (args.notificationId) {
          const previous = activeNotificationsById.get(args.notificationId)
          if (previous) {
            previous.notification.close()
            previous.release()
          }
        }

        // Why: prevent GC from collecting the notification (and its click
        // handler) while it's still visible in macOS Notification Center.
        let clickHandler: (() => void) | null = null
        let failedHandler: ((_event: unknown, error?: string) => void) | null = null
        const entryForId: { notification: Notification; release: () => void } | null =
          args.notificationId ? { notification, release: () => {} } : null
        const release = retainNotificationUntilRelease(notification, () => {
          if (clickHandler) {
            notification.removeListener('click', clickHandler)
            clickHandler = null
          }
          if (failedHandler) {
            notification.removeListener('failed', failedHandler)
            failedHandler = null
          }
          if (
            args.notificationId &&
            activeNotificationsById.get(args.notificationId) === entryForId
          ) {
            activeNotificationsById.delete(args.notificationId)
          }
        })
        if (entryForId && args.notificationId) {
          entryForId.release = release
          activeNotificationsById.set(args.notificationId, entryForId)
        }

        failedHandler = (_event, error) => {
          // Why: Electron 42's macOS UNNotification backend reports unsigned
          // apps and native delivery errors here; release immediately instead
          // of retaining a dead notification until the fallback timer.
          logNativeNotificationFailure(args.source, error)
          // A definitive rejection — feeds the permission card's evidence.
          lastObservedDeliveryOutcome = 'failed'
          release()
        }
        notification.on('failed', failedHandler)

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
            lastObservedDeliveryOutcome = 'delivered'
            return { delivered: true }
          })
        }

        return { delivered: true }
      }

      if (process.platform !== 'darwin') {
        return deliverNativeNotification()
      }
      // Why: macOS silently swallows accepted notifications while permission
      // is denied or the permission dialog is unanswered (verified on macOS
      // 26). Skip the doomed native notification and tell the caller, so the
      // renderer can surface an in-app fallback pointing at System Settings.
      // The mobile dispatch above is unaffected — paired devices have their
      // own notification channel.
      return readNotificationAuthorizationStatus().then((authorization) => {
        if (authorization === 'denied' || authorization === 'not-determined') {
          lastObservedDeliveryOutcome = 'failed'
          return { delivered: false, reason: 'blocked-by-system' }
        }
        return deliverNativeNotification()
      })
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
    notification.removeListener('failed', onFailed)
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

  function onFailed(_event: unknown, error?: string): void {
    // Why: Electron 42 requires code-signed macOS apps for UNNotification
    // delivery. Unsigned builds fail here instead of producing the permission UI.
    logNativeNotificationFailure('startup registration', error)
    lastObservedDeliveryOutcome = 'failed'
    cleanup()
  }

  notification.on('click', onClick)
  notification.on('show', onShow)
  notification.on('failed', onFailed)

  // Fallback in case macOS doesn't fire the 'show' event (e.g. user denies).
  fallbackTimer = setTimeout(cleanup, 10_000)
  if (typeof fallbackTimer.unref === 'function') {
    fallbackTimer.unref()
  }

  notification.show()
}
