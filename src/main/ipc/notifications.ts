import { BrowserWindow, Notification, ipcMain, powerMonitor } from 'electron'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import type { Store } from '../persistence/loading-store/store'
import type {
  NotificationAttentionAcknowledgement,
  NotificationDeliveryProbeResult,
  NotificationDismissResult,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationPermissionStatusResult,
  StructuredNotificationRead
} from '../../shared/notification-settings-types'
import { isNotificationAttentionAcknowledgement } from '../../shared/notification-settings-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readNotificationAuthorizationStatus } from './notification-authorization-status'
import { setTrayAttention } from '../tray/system-tray'
import { isMainWindowVisible } from '../window/main-window-visibility'
import { activeNotificationsById } from './native-notification-lifecycle'
import { deliverNativeNotification } from './native-notification-delivery'
import { notificationIconFromRepoIcon } from './notification-repo-icon'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { removeReadMacosNotifications } from './macos-notification-center'
import { createNotificationDeliveryService } from '../notifications/notification-delivery-service'
import {
  createAnnouncedNotificationRegistry,
  type AnnouncedNotification
} from '../notifications/announced-notification-registry'
import { registerNotificationSoundHandlers } from './notification-sound-ipc'
import { openNotificationSystemSettings } from './notification-system-settings-link'
import { isStructuredAttentionRead } from '../../shared/agent-session/agent-session-attention'
import { isAgentSessionExecutionLocation } from '../../shared/agent-session/lifecycle/agent-session-record'
import {
  getLastObservedDeliveryOutcome,
  hasTriggeredPermissionDialogThisSession,
  probeNotificationDelivery,
  recordNotificationDeliveryOutcome,
  resetNotificationPermissionEvidence
} from './notification-permission-probe'

let stopRuntimeAttentionEvents: (() => void) | undefined

export function registerNotificationHandlers(store: Store, runtime?: OrcaRuntimeService): void {
  ipcMain.removeHandler('notifications:getDesktopAwayState')
  ipcMain.handle('notifications:getDesktopAwayState', () => readDesktopAwayState(powerMonitor))
  resetNotificationPermissionEvidence()

  ipcMain.removeHandler('notifications:openSystemSettings')
  ipcMain.removeHandler('notifications:getPermissionStatus')
  ipcMain.removeHandler('notifications:probeDelivery')
  ipcMain.handle('notifications:openSystemSettings', (): void => {
    openNotificationSystemSettings()
  })

  // Keep the legacy status surface observational; native authorization is read by onboarding below.
  const getPermissionStatus = (): NotificationPermissionStatusResult => ({
    supported: Notification.isSupported(),
    platform: process.platform,
    requested: store.getUI().notificationPermissionRequested === true
  })

  ipcMain.handle('notifications:getPermissionStatus', getPermissionStatus)
  ipcMain.handle(
    'notifications:probeDelivery',
    async (_event, args?: { force?: boolean }): Promise<NotificationDeliveryProbeResult> => {
      // First-use permission onboarding is macOS-only.
      if (process.platform !== 'darwin' || !Notification.isSupported()) {
        return { state: 'unsupported', authoritative: false }
      }
      // Record prompting intent so startup registration cannot trigger a second prompt.
      if (store.getUI().notificationPermissionRequested !== true) {
        store.updateUI({ notificationPermissionRequested: true })
      }
      // Prefer silent native reads so System Settings changes are visible without probe banners.
      const authorization = await readNotificationAuthorizationStatus()
      if (authorization === 'authorized') {
        recordNotificationDeliveryOutcome('delivered')
        return { state: 'delivered', authoritative: true }
      }
      if (authorization === 'denied') {
        recordNotificationDeliveryOutcome('failed')
        return { state: 'blocked', authoritative: true }
      }
      if (authorization === 'not-determined') {
        // Trigger the first-use presenter once, then report awaiting-decision.
        if (!hasTriggeredPermissionDialogThisSession()) {
          void probeNotificationDelivery()
        }
        return { state: 'awaiting-decision', authoritative: true }
      }
      // Without native evidence, cache scheduling probes within the session to avoid repeat banners.
      const lastObservedDeliveryOutcome = getLastObservedDeliveryOutcome()
      if (!args?.force && lastObservedDeliveryOutcome !== null) {
        return {
          state: lastObservedDeliveryOutcome === 'delivered' ? 'delivered' : 'blocked',
          authoritative: false
        }
      }
      return probeNotificationDelivery()
    }
  )

  const announced = createAnnouncedNotificationRegistry()

  const closeNativeAnnouncements = (entries: readonly AnnouncedNotification[]): number => {
    let dismissed = 0
    for (const entry of entries) {
      const native = activeNotificationsById.get(entry.id)
      if (native) {
        native.notification.close()
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

  const deliveryService = createNotificationDeliveryService({
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
    deliverNative: (request, options, settings) => {
      const repo = request.worktreeId
        ? store.getRepo(getRepoIdFromWorktreeId(request.worktreeId))
        : undefined
      const icon = notificationIconFromRepoIcon(repo?.repoIcon)
      return deliverNativeNotification(request, icon ? { ...options, icon } : options, settings)
    },
    platform: process.platform,
    now: () => Date.now(),
    wasRead: announced.wasRead,
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
    (
      _event,
      args: NotificationDispatchRequest
    ): NotificationDispatchResult | Promise<NotificationDispatchResult> =>
      deliveryService.dispatch(args)
  )

  registerNotificationSoundHandlers(store)
}
