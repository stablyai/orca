import { BrowserWindow, Notification, ipcMain, powerMonitor } from 'electron'
import { readDesktopAwayState } from '../../notifications/desktop-away-state'
import { closeDesktopNotification } from '../../notifications/desktop-notification'
import type { Store } from '../../persistence/loading-store/store'
import type {
  NotificationAttentionAcknowledgement,
  NotificationDismissResult,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  StructuredNotificationRead
} from '../../../shared/notifications/notification-settings-types'
import { isNotificationAttentionAcknowledgement } from '../../../shared/notifications/notification-settings-types'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { setTrayAttention } from '../../tray/system-tray'
import { isMainWindowVisible } from '../../window/visibility/main-window-visibility'
import { activeNotificationsById } from './native-notification-lifecycle'
import { removeReadMacosNotifications } from './macos-notification-center'
import type { createNotificationDeliveryService } from '../../notifications/notification-delivery-service'
import {
  createAnnouncedNotificationRegistry,
  type AnnouncedNotification
} from '../../notifications/announced-notification-registry'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import { isStructuredAttentionRead } from '../../../shared/agent-session/view/agent-session-attention'
import { isAgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'

const NOTIFICATION_PERMISSION_IPC_CHANNELS = [
  'notifications:openSystemSettings',
  'notifications:getPermissionStatus',
  'notifications:probeDelivery'
] as const

let stopRuntimeAttentionEvents: (() => void) | undefined

export function registerNotificationHandlers(store: Store, runtime?: OrcaRuntimeService): void {
  ipcMain.removeHandler('notifications:getDesktopAwayState')
  ipcMain.handle('notifications:getDesktopAwayState', () => readDesktopAwayState(powerMonitor))

  for (const channel of NOTIFICATION_PERMISSION_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(NOTIFICATION_PERMISSION_IPC_CHANNELS, async (ipc) => {
    const { registerNotificationPermissionHandlers } = await import('./notification-permission-ipc')
    registerNotificationPermissionHandlers(store, ipc)
  })

  const announced = createAnnouncedNotificationRegistry()

  const closeNativeAnnouncements = (entries: readonly AnnouncedNotification[]): number => {
    let dismissed = 0
    for (const entry of entries) {
      const native = activeNotificationsById.get(entry.id)
      if (native) {
        closeDesktopNotification(native.notification)
        native.release()
        dismissed += 1
      }
    }
    return dismissed
  }
  const discardEvictedAnnouncements = (entries: readonly AnnouncedNotification[]): void => {
    closeNativeAnnouncements(entries)
    for (const entry of entries) {
      if (entry.paneKey && !entry.pendingOnly) {
        removeReadMacosNotifications(entry.paneKey, [entry], false)
      }
    }
  }

  const retireAnnouncements = (
    retired: readonly AnnouncedNotification[],
    paneKeys: string[] = []
  ): number => {
    const dismissed = closeNativeAnnouncements(retired)
    const byPane = new Map<string, AnnouncedNotification[]>(
      paneKeys.map((paneKey) => [paneKey, []])
    )
    for (const entry of retired) {
      if (entry.paneKey && !entry.pendingOnly) {
        const entries = byPane.get(entry.paneKey) ?? []
        entries.push(entry)
        byPane.set(entry.paneKey, entries)
      }
      if (!entry.origin && !entry.pendingOnly) {
        runtime?.dismissMobileNotification(entry.id)
      }
    }
    for (const [paneKey, entries] of byPane) {
      removeReadMacosNotifications(paneKey, entries, !announced.hasUnpositionedSubject(paneKey))
    }
    return dismissed
  }

  const acknowledge = (
    acknowledgement: NotificationAttentionAcknowledgement,
    executionHost?: NotificationDispatchRequest['executionHost']
  ): NotificationDismissResult => {
    if (!isNotificationAttentionAcknowledgement(acknowledgement)) {
      return { dismissed: 0 }
    }
    const retired = announced.takeAcknowledged(acknowledgement, executionHost)
    if (executionHost) {
      runtime?.retireNotificationAttention?.(acknowledgement, executionHost)
    }
    return { dismissed: retireAnnouncements(retired) }
  }
  stopRuntimeAttentionEvents?.()
  stopRuntimeAttentionEvents = runtime?.onClientEvent?.(
    (event) => {
      if (event.type === 'notificationAttentionAcknowledged') {
        acknowledge(event.acknowledgement)
      }
    },
    { consumesTerminalSideEffects: false }
  )

  ipcMain.removeHandler('notifications:acknowledgeAttention')
  ipcMain.handle(
    'notifications:acknowledgeAttention',
    (
      _event,
      acknowledgement: NotificationAttentionAcknowledgement,
      executionHost?: NotificationDispatchRequest['executionHost']
    ) => acknowledge(acknowledgement, executionHost)
  )

  ipcMain.removeHandler('notifications:dismiss')
  ipcMain.handle(
    'notifications:dismiss',
    (
      _event,
      ids: string[],
      paneKeys?: string[],
      reads?: StructuredNotificationRead[]
    ): NotificationDismissResult => {
      const retired = new Map<string, AnnouncedNotification>()
      for (const id of ids.filter(
        (id) =>
          typeof id === 'string' &&
          id.length > 0 &&
          !id.startsWith('agent-attention:') &&
          !announced.isBounded(id) &&
          (!paneKeys?.length || !announced.hasAnnouncement({ notificationId: id }))
      )) {
        retired.set(id, { id })
      }
      for (const paneKey of Array.isArray(paneKeys) ? paneKeys : []) {
        if (typeof paneKey !== 'string') {
          continue
        }
        const read = Array.isArray(reads)
          ? reads.find((item) => isStructuredAttentionRead(item) && item.paneKey === paneKey)
          : undefined
        const entries = announced.take(paneKey, read)
        for (const entry of entries) {
          retired.set(entry.id, entry)
        }
        if (read) {
          runtime?.retireNotificationAttention?.({ reads: [read] }, read.executionHost)
        }
      }
      return {
        dismissed: retireAnnouncements(
          [...retired.values()],
          paneKeys?.filter((key) => typeof key === 'string')
        )
      }
    }
  )

  let deliveryServicePromise: Promise<ReturnType<typeof createNotificationDeliveryService>> | null =
    null
  const getDeliveryService = (): Promise<ReturnType<typeof createNotificationDeliveryService>> => {
    if (!deliveryServicePromise) {
      deliveryServicePromise = Promise.all([
        import('../../notifications/notification-delivery-service'),
        import('./notification-authorization-status'),
        import('./notification-permission-probe'),
        import('./native-notification-delivery'),
        import('../../external-conversations/external-conversation-links')
      ]).then(
        ([
          { createNotificationDeliveryService: createService },
          { readNotificationAuthorizationStatus },
          { recordNotificationDeliveryOutcome },
          { deliverNativeNotification },
          { sessionRepliesInSlack }
        ]) =>
          createService({
            readNotificationSettings: () => store.getSettings().notifications,
            findActiveWindow: () =>
              BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ?? null,
            isWindowVisible: isMainWindowVisible,
            setTrayAttention,
            isNotificationSupported: () => Notification.isSupported(),
            dispatchMobileNotification: runtime
              ? (payload) => runtime.dispatchMobileNotification(payload)
              : null,
            readAuthorizationStatus: readNotificationAuthorizationStatus,
            recordDeliveryOutcome: recordNotificationDeliveryOutcome,
            deliverNative: deliverNativeNotification,
            platform: process.platform,
            now: () => Date.now(),
            wasRead: announced.wasRead,
            repliesInSlack: (sessionId) => sessionRepliesInSlack(store, sessionId),
            reserveNative: (request) => {
              if (!request.notificationId || (!request.paneKey && !request.worktreeId)) {
                return undefined
              }
              const reservation = announced.reserveNative(
                request.paneKey ?? `worktree:${request.worktreeId}`,
                request.notificationId,
                request.structuredOrigin,
                request
              )
              discardEvictedAnnouncements(reservation.evicted)
              return reservation
            },
            recordAnnounced: (request) => {
              if (request.notificationId && (request.paneKey || request.worktreeId)) {
                if (announced.wasRead(request)) {
                  retireAnnouncements([
                    {
                      id: request.notificationId,
                      origin: request.structuredOrigin,
                      paneKey: request.paneKey
                    }
                  ])
                  return
                }
                discardEvictedAnnouncements(
                  announced.record(
                    request.paneKey ?? `worktree:${request.worktreeId}`,
                    request.notificationId,
                    request.structuredOrigin,
                    request
                  )
                )
              }
            }
          })
      )
    }
    return deliveryServicePromise
  }

  // A cleared remote prompt must also retire alerts forwarded to this desktop's phones.
  ipcMain.removeHandler('notifications:settleStructuredPrompts')
  ipcMain.handle(
    'notifications:settleStructuredPrompts',
    (
      _event,
      scope: unknown,
      sessionId: unknown,
      executionHost?: NotificationDispatchRequest['executionHost']
    ): void => {
      if (isAgentSessionExecutionLocation(scope) && typeof sessionId === 'string' && sessionId) {
        runtime?.reconcileStructuredPromptAttention({
          scope,
          sessionId,
          pendingPromptIds: [],
          executionHost
        })
      }
    }
  )

  ipcMain.removeHandler('notifications:dispatch')
  ipcMain.handle(
    'notifications:dispatch',
    async (_event, args: NotificationDispatchRequest): Promise<NotificationDispatchResult> => {
      const deliveryService = await getDeliveryService()
      return deliveryService.dispatch(args)
    }
  )

  ipcMain.removeHandler('notifications:resolveSoundPath')
  ipcMain.removeHandler('notifications:loadSound')
  registerLazyIpcHandleGroup(
    ['notifications:resolveSoundPath', 'notifications:loadSound'],
    async (ipc) => {
      const { registerNotificationSoundHandlers } = await import('./notification-sound-ipc')
      registerNotificationSoundHandlers(store, ipc)
    }
  )
}
