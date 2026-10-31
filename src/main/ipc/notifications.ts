import { createForwardedPushAuthority } from '../notifications/forwarded-push-authority'
import type { getForwardedPushSource } from './runtime-environments/runtime-environments'
import { getRuntimeEnvironmentRegistryRoot } from './runtime-environments/runtime-environment-registry-root'
import { BrowserWindow, Notification, ipcMain, powerMonitor } from 'electron'
import { structuredPushOccurrence } from '../notifications/structured-push-identity'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { readDesktopAwayState } from '../notifications/desktop-away-state'
import type { Store } from '../persistence'
import type {
  NotificationDeliveryProbeResult,
  NotificationDismissResult,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationPermissionStatusResult,
  StructuredNotificationRead
} from '../../shared/notification-settings-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { readNotificationAuthorizationStatus } from './notification-authorization-status'
import { setTrayAttention } from '../tray/system-tray'
import { isMainWindowVisible } from '../window/main-window-visibility'
import { activeNotificationsById } from './native-notification-lifecycle'
import { deliverNativeNotification } from './native-notification-delivery'
import { removeReadMacosNotifications } from './macos-notification-center'
import { createNotificationDeliveryService } from '../notifications/notification-delivery-service'
import { createAnnouncedNotificationRegistry } from '../notifications/announced-notification-registry'
import {
  registerNotificationSoundHandlers,
  type NotificationSoundStore
} from './notification-sound-ipc'
import { openNotificationSystemSettings } from './notification-system-settings-link'
import { isStructuredAttentionRead } from '../../shared/agent-session-attention'
import { isAgentSessionExecutionLocation } from '../../shared/agent-session-record'
import {
  getLastObservedDeliveryOutcome,
  hasTriggeredPermissionDialogThisSession,
  probeNotificationDelivery,
  recordNotificationDeliveryOutcome,
  resetNotificationPermissionEvidence
} from './notification-permission-probe'

export type NotificationHandlerStore = NotificationSoundStore & {
  getUI: () => Pick<ReturnType<Store['getUI']>, 'notificationPermissionRequested'>
  updateUI: Store['updateUI']
}

export type NotificationHandlerRuntime = Pick<
  OrcaRuntimeService,
  | 'getForwardedNotificationEnvironments'
  | 'onForwardedNotificationEnvironmentsChanged'
  | 'refreshForwardedNotificationEnvironments'
  | 'retireStructuredAttention'
  | 'dismissMobileNotification'
  | 'reconcileStructuredPromptAttention'
  | 'dispatchMobileNotification'
>

export function registerNotificationHandlers(
  store: NotificationHandlerStore,
  runtime?: NotificationHandlerRuntime,
  findSource?: typeof getForwardedPushSource
): void {
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
  ipcMain.removeHandler('notifications:getForwardedEnvironments')
  ipcMain.handle(
    'notifications:getForwardedEnvironments',
    () => runtime?.getForwardedNotificationEnvironments() ?? []
  )
  runtime?.onForwardedNotificationEnvironmentsChanged((environments) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('notifications:forwardedEnvironments', environments)
      }
    }
  })
  powerMonitor.on('resume', () => runtime?.refreshForwardedNotificationEnvironments())

  ipcMain.removeHandler('notifications:applyRemoteStructuredRead')
  ipcMain.handle('notifications:applyRemoteStructuredRead', (_event, read: unknown) => {
    if (isStructuredAttentionRead(read)) {
      runtime?.retireStructuredAttention(read)
    }
  })

  ipcMain.removeHandler('notifications:dismiss')
  ipcMain.handle(
    'notifications:dismiss',
    (
      _event,
      ids: string[],
      paneKeys?: string[],
      reads?: StructuredNotificationRead[]
    ): NotificationDismissResult => {
      const uniqueIds = new Set(
        ids.filter(
          (id): id is string =>
            typeof id === 'string' &&
            id.length > 0 &&
            !id.startsWith('agent-attention:') &&
            !announced.isBounded(id)
        )
      )
      const genericMobileIds = new Set(uniqueIds)
      // Positioned structured alerts need the journal boundary; pane-wide reads retire the rest.
      for (const paneKey of Array.isArray(paneKeys) ? paneKeys : []) {
        if (typeof paneKey === 'string') {
          const read = Array.isArray(reads)
            ? reads.find((item) => isStructuredAttentionRead(item) && item.paneKey === paneKey)
            : undefined
          const retired = announced.take(paneKey, read)
          for (const entry of retired) {
            uniqueIds.add(entry.id)
            if (!entry.origin) {
              genericMobileIds.add(entry.id)
            }
          }
          removeReadMacosNotifications(paneKey, retired)
          if (read) {
            runtime?.retireStructuredAttention(read)
            getStructuredAgentSessionHost()?.publishAttentionRead(read)
          }
        }
      }
      let dismissed = 0
      for (const id of uniqueIds) {
        const entry = activeNotificationsById.get(id)
        if (entry) {
          entry.notification.close()
          entry.release()
          dismissed += 1
        }
        if (genericMobileIds.has(id)) {
          runtime?.dismissMobileNotification(id)
        }
      }
      return { dismissed }
    }
  )

  const authority = createForwardedPushAuthority(getRuntimeEnvironmentRegistryRoot)
  const sourceProofs = new WeakMap<
    NotificationDispatchRequest,
    ReturnType<typeof getForwardedPushSource>
  >()
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
    deliverNative: deliverNativeNotification,
    platform: process.platform,
    now: () => Date.now(),
    resolveMobileOrigin: (request) => {
      const proof = sourceProofs.get(request)
      return request.occurrence &&
        proof &&
        request.executionHost === `runtime:${proof.source.environmentId}`
        ? authority.resolve(proof.source, proof.isCurrent)
        : undefined
    },
    recordAnnounced: (request) => {
      if (request.paneKey && request.notificationId) {
        announced.record(request.paneKey, request.notificationId, request.structuredOrigin)
      }
    }
  })

  // A cleared remote prompt must also retire alerts forwarded to this desktop's phones.
  ipcMain.removeHandler('notifications:settleStructuredPrompts')
  ipcMain.handle(
    'notifications:settleStructuredPrompts',
    (_event, scope: unknown, sessionId: unknown): void => {
      if (isAgentSessionExecutionLocation(scope) && typeof sessionId === 'string' && sessionId) {
        runtime?.reconcileStructuredPromptAttention({ scope, sessionId, pendingPromptIds: [] })
      }
    }
  )

  ipcMain.removeHandler('notifications:dispatch')
  ipcMain.handle(
    'notifications:dispatch',
    (
      event,
      args: NotificationDispatchRequest
    ): NotificationDispatchResult | Promise<NotificationDispatchResult> => {
      const request = {
        ...args,
        occurrence: structuredPushOccurrence(args.notificationId, args.structuredOrigin),
        origin: undefined
      }
      if (args.forwardingEnvironmentId && event.sender) {
        sourceProofs.set(
          request,
          findSource?.(event.sender.id, args.forwardingEnvironmentId, args.forwardingSource)
        )
      }
      return deliveryService.dispatch(request)
    }
  )

  registerNotificationSoundHandlers(store)
}
