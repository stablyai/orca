/**
 * Desktop delivery policy for dispatched notifications.
 *
 * Lifted out of the `notifications:dispatch` IPC closure so the ordering that matters —
 * tray attention before the gates, mobile fan-out before the desktop early returns — is
 * expressed once against injected collaborators instead of ambient Electron singletons.
 */
import type { BrowserWindow } from 'electron'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationSettings
} from '../../shared/notification-settings-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { buildNotificationOptions } from '../ipc/notification-options'
import { reserveNotificationCooldown } from '../ipc/notification-burst-cooldown'

export type NotificationDeliveryDependencies = {
  readNotificationSettings: () => NotificationSettings
  /** The window the user would see the banner on, or null when none is open. */
  findActiveWindow: () => BrowserWindow | null
  isWindowVisible: (window: BrowserWindow | null) => boolean
  setTrayAttention: (attention: boolean) => void
  isNotificationSupported: () => boolean
  /** Null when no runtime is paired, so mobile fan-out is skipped entirely. */
  dispatchMobileNotification: OrcaRuntimeService['dispatchMobileNotification'] | null
  readAuthorizationStatus: () => Promise<
    'authorized' | 'denied' | 'not-determined' | 'unknown' | null
  >
  recordDeliveryOutcome: (outcome: 'delivered' | 'failed') => void
  deliverNative: (
    request: NotificationDispatchRequest,
    options: ReturnType<typeof buildNotificationOptions>,
    settings: NotificationSettings
  ) => NotificationDispatchResult | Promise<NotificationDispatchResult>
  platform: NodeJS.Platform
  now: () => number
}

export type NotificationDeliveryService = {
  dispatch: (
    request: NotificationDispatchRequest
  ) => NotificationDispatchResult | Promise<NotificationDispatchResult>
}

export function createNotificationDeliveryService(
  deps: NotificationDeliveryDependencies
): NotificationDeliveryService {
  const recentDesktopNotifications = new Map<string, number>()
  const recentMobileNotifications = new Map<string, number>()

  // Why: agent-task-complete and terminal-bell intentionally share one cooldown bucket per
  // worktree (they often co-fire and only the first should surface), but needs-attention is a
  // fully independent external-tool signal — sharing that bucket let a just-fired agent
  // notification silently swallow a distinct needs-attention notification for 5s afterward.
  const dedupeKeyFor = (request: NotificationDispatchRequest): string => {
    const worktreeKey = request.worktreeId ?? request.worktreeLabel ?? 'global'
    return request.source === 'needs-attention' ? `needs-attention:${worktreeKey}` : worktreeKey
  }

  return {
    dispatch: (request) => {
      // Why: light the tray attention dot before the cooldown/focus/enabled gates so they
      // can't hold it back (clears on window show/restore; see index.ts).
      if (
        request.source === 'agent-task-complete' ||
        request.source === 'terminal-bell' ||
        request.source === 'needs-attention'
      ) {
        if (!deps.isWindowVisible(deps.findActiveWindow())) {
          deps.setTrayAttention(true)
        }
      }

      const settings = deps.readNotificationSettings()
      const desktopAllowed =
        settings.enabled &&
        (request.source !== 'agent-task-complete' || settings.agentTaskComplete) &&
        (request.source !== 'terminal-bell' || settings.terminalBell) &&
        (request.source !== 'needs-attention' || settings.needsAttention)

      const notificationOptions = buildNotificationOptions(request)

      // Why: desktop focus only means this computer sees the worktree; the paired phone may still need the alert.
      if (deps.dispatchMobileNotification && request.source !== 'test') {
        if (
          reserveNotificationCooldown(
            recentMobileNotifications,
            JSON.stringify([
              desktopAllowed,
              request.source,
              request.agentState,
              dedupeKeyFor(request)
            ]),
            deps.now()
          )
        ) {
          deps.dispatchMobileNotification({
            type: 'notification',
            emittedAt: deps.now(),
            source: request.source,
            ...(!desktopAllowed ? { desktopAllowed: false } : {}),
            title: notificationOptions.title,
            body: notificationOptions.body,
            worktreeId: request.worktreeId,
            ...(request.notificationId ? { notificationId: request.notificationId } : {}),
            // Why: background push needs the agent's real state to pick "needs input"
            // vs "finished" — and to stay silent while the agent is still working.
            ...(request.agentState ? { agentState: request.agentState } : {})
          })
        }
      }

      if (!desktopAllowed) {
        return { delivered: false, reason: settings.enabled ? 'source-disabled' : 'disabled' }
      }

      const browserWindow = deps.findActiveWindow()
      if (
        settings.suppressWhenFocused &&
        request.isActiveWorktree &&
        browserWindow &&
        browserWindow.isFocused()
      ) {
        return { delivered: false, reason: 'suppressed-focus' }
      }

      // Why: the Settings test button is an explicit, often-repeated user action, so it bypasses burst dedupe.
      if (request.source !== 'test') {
        // Dedupe by worktree, not source — agent-finish and terminal-bell often fire in one chunk; surface only the first.
        if (
          !reserveNotificationCooldown(
            recentDesktopNotifications,
            dedupeKeyFor(request),
            deps.now()
          )
        ) {
          return { delivered: false, reason: 'cooldown' }
        }
      }

      if (!deps.isNotificationSupported()) {
        return { delivered: false, reason: 'not-supported' }
      }

      if (deps.platform !== 'darwin') {
        return deps.deliverNative(request, notificationOptions, settings)
      }
      // Why: macOS silently swallows notifications while permission is denied/undecided (verified macOS 26); skip so the renderer can show a fallback.
      return deps.readAuthorizationStatus().then((authorization) => {
        if (authorization === 'denied' || authorization === 'not-determined') {
          deps.recordDeliveryOutcome('failed')
          return { delivered: false, reason: 'blocked-by-system' }
        }
        return deps.deliverNative(request, notificationOptions, settings)
      })
    }
  }
}
