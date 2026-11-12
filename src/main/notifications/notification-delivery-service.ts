import type { BrowserWindow } from 'electron'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationSettings
} from '../../shared/notification-settings-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { buildNotificationOptions } from '../ipc/notification-options'
import { translateMain } from '../i18n/main-i18n'
import { reserveNotificationCooldown } from '../../shared/notification-burst-cooldown'
import { toHostSessionPaneKey } from '../../shared/workspace-layout/terminal-surface-id'
import { isNotificationSourceEnabled } from '../../shared/notification-source-gate'
import { notificationDeliveryId } from '../../shared/notification-delivery-id'

type NativeNotificationReservation = {
  isCurrent: () => boolean
  release: () => void
}

export type NotificationDeliveryDependencies = {
  readNotificationSettings: () => NotificationSettings
  findActiveWindow: () => BrowserWindow | null
  isWindowVisible: (window: BrowserWindow | null) => boolean
  setTrayAttention: (attention: boolean) => void
  isNotificationSupported: () => boolean
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
  reserveNative?: (
    request: NotificationDispatchRequest
  ) => NativeNotificationReservation | undefined
  wasRead?: (request: NotificationDispatchRequest) => boolean
  /** Called for each actual desktop banner or mobile alert. */
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

  // Keyed news is announced once by its producer, so only its own repeat may collapse it.
  const dedupeKeyFor = (request: NotificationDispatchRequest): string =>
    JSON.stringify([
      request.executionHost,
      request.attentionKey ?? request.worktreeId ?? request.worktreeLabel ?? 'global'
    ])

  const deliverNativeAndRecord = (
    request: NotificationDispatchRequest,
    options: ReturnType<typeof buildNotificationOptions>,
    settings: NotificationSettings,
    reservation?: NativeNotificationReservation
  ): NotificationDispatchResult | Promise<NotificationDispatchResult> => {
    const recordIfDelivered = (result: NotificationDispatchResult): NotificationDispatchResult => {
      if (result.delivered && reservation?.isCurrent() === false) {
        return { delivered: false, reason: 'already-read' }
      }
      if (result.delivered) {
        deps.recordAnnounced?.(request)
      }
      return result
    }
    const result = deps.deliverNative(request, options, settings)
    return result instanceof Promise ? result.then(recordIfDelivered) : recordIfDelivered(result)
  }

  return {
    /** Tray attention and phone fan-out precede desktop-only mutes so window focus cannot silence remote alerts. */
    dispatch: (request) => {
      if (request.executionHost && request.notificationId) {
        request = {
          ...request,
          notificationId: notificationDeliveryId(request.notificationId, request.executionHost)
        }
      }
      if (deps.wasRead?.(request)) {
        return { delivered: false, reason: 'already-read' }
      }
      // Desktop gates must not suppress tray attention.
      if (request.source === 'agent-task-complete' || request.source === 'terminal-bell') {
        if (!deps.isWindowVisible(deps.findActiveWindow())) {
          deps.setTrayAttention(true)
        }
      }

      const settings = deps.readNotificationSettings()
      const hostMuted =
        request.notificationSourceId !== undefined &&
        settings.mutedNotificationSourceIds.includes(request.notificationSourceId)
      // Machine mutes leave mobile eligibility and its cooldown unchanged.
      const desktopAllowed = isNotificationSourceEnabled(
        settings,
        request.source,
        request.agentState,
        request.agentToolName
      )

      const notificationOptions = buildNotificationOptions(request, translateMain)

      // Desktop focus need not silence phones; execution hosts retire their own delivered alerts.
      if (
        !request.mobileDeliveredByHost &&
        deps.dispatchMobileNotification &&
        request.source !== 'test'
      ) {
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
            ...(request.workspaceExecutionHostId !== undefined
              ? { workspaceExecutionHostId: request.workspaceExecutionHostId }
              : {}),
            // The phone asks the execution host for tabs, which never name this window's mirror tabs.
            ...(request.paneKey ? { paneKey: toHostSessionPaneKey(request.paneKey) } : {}),
            ...(request.executionHost ? { executionHost: request.executionHost } : {}),
            ...(request.notificationId ? { notificationId: request.notificationId } : {}),
            // Push needs real agent state to distinguish input/completion and silence running agents.
            ...(request.agentState ? { agentState: request.agentState } : {}),
            ...(request.attentionKey ? { attentionKey: request.attentionKey } : {}),
            ...(request.structuredOrigin ? { structuredOrigin: request.structuredOrigin } : {})
          })
          deps.recordAnnounced?.(request)
        }
      }

      if (!desktopAllowed || hostMuted) {
        return {
          delivered: false,
          reason: !settings.enabled ? 'disabled' : hostMuted ? 'host-muted' : 'source-disabled'
        }
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

      // Explicit Settings tests bypass burst deduplication.
      if (request.source !== 'test') {
        // Collapse unkeyed worktree events across sources; attention keys isolate their own repeats.
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

      const reservation = deps.reserveNative?.(request)
      const deliverNative = () =>
        deliverNativeAndRecord(request, notificationOptions, settings, reservation)
      try {
        // macOS swallows denied/undecided notifications; allow the renderer fallback instead.
        const result =
          deps.platform !== 'darwin'
            ? deliverNative()
            : deps.readAuthorizationStatus().then((authorization) => {
                if (deps.wasRead?.(request) || reservation?.isCurrent() === false) {
                  return { delivered: false, reason: 'already-read' } as const
                }
                if (authorization === 'denied' || authorization === 'not-determined') {
                  deps.recordDeliveryOutcome('failed')
                  return { delivered: false, reason: 'blocked-by-system' } as const
                }
                return deliverNative()
              })
        if (result instanceof Promise) {
          return result.finally(() => reservation?.release())
        }
        reservation?.release()
        return result
      } catch (error) {
        reservation?.release()
        throw error
      }
    }
  }
}
