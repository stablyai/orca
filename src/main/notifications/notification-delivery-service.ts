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
import { allowsWorkspaceAgentNotification } from '../../shared/workspace-notification-policy'

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
  /** Told once per path that actually announced the request: a desktop banner shown, or a mobile alert sent. */
  recordAnnounced?: (request: NotificationDispatchRequest) => void
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

  const dedupeKeyFor = (request: NotificationDispatchRequest): string =>
    request.worktreeId ?? request.worktreeLabel ?? 'global'

  const deliverNativeAndRecord = (
    request: NotificationDispatchRequest,
    options: ReturnType<typeof buildNotificationOptions>,
    settings: NotificationSettings
  ): NotificationDispatchResult | Promise<NotificationDispatchResult> => {
    const recordIfDelivered = (result: NotificationDispatchResult): NotificationDispatchResult => {
      if (result.delivered) {
        deps.recordAnnounced?.(request)
      }
      return result
    }
    const result = deps.deliverNative(request, options, settings)
    return result instanceof Promise ? result.then(recordIfDelivered) : recordIfDelivered(result)
  }

  return {
    dispatch: (request) => {
      // Why: light the tray attention dot before the cooldown/focus/enabled gates so they
      // can't hold it back (clears on window show/restore; see index.ts).
      if (request.source === 'agent-task-complete' || request.source === 'terminal-bell') {
        if (!deps.isWindowVisible(deps.findActiveWindow())) {
          deps.setTrayAttention(true)
        }
      }

      const settings = deps.readNotificationSettings()
      const desktopAllowed =
        settings.enabled &&
        (request.source !== 'agent-task-complete' ||
          (settings.agentTaskComplete &&
            allowsWorkspaceAgentNotification(
              settings,
              request.workspaceOrigin,
              request.agentState
            ))) &&
        (request.source !== 'terminal-bell' || settings.terminalBell)

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
          deps.recordAnnounced?.(request)
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
        return deliverNativeAndRecord(request, notificationOptions, settings)
      }
      // Why: macOS silently swallows notifications while permission is denied/undecided (verified macOS 26); skip so the renderer can show a fallback.
      return deps.readAuthorizationStatus().then((authorization) => {
        if (authorization === 'denied' || authorization === 'not-determined') {
          deps.recordDeliveryOutcome('failed')
          return { delivered: false, reason: 'blocked-by-system' }
        }
        return deliverNativeAndRecord(request, notificationOptions, settings)
      })
    }
  }
}
