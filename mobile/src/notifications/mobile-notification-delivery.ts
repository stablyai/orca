import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { buildLocalNotificationData, type DesktopNotificationSource } from './notification-routing'
import { MobileNotificationDeliveryLedger } from './mobile-notification-retention'
import {
  MobileScheduledNotificationRegistry,
  type MobileScheduledNotificationState
} from './mobile-scheduled-notification-registry'

export type NotificationEvent = {
  type: 'notification'
  source: DesktopNotificationSource
  title: string
  body: string
  worktreeId?: string
  notificationId?: string
  notificationSeq?: number
}

export type DismissNotificationEvent = {
  type: 'dismiss'
  notificationId: string
  notificationSeq?: number
}

const scheduledNotifications = new MobileScheduledNotificationRegistry()
const notificationDeliveryLedger = new MobileNotificationDeliveryLedger()

function getStoredNotificationKey(hostId: string, notificationId: string): string {
  return `${encodeURIComponent(hostId)}:${encodeURIComponent(notificationId)}`
}

/** Test-only: override the cap (pass no arg to restore the default). */
export function setScheduledNotificationsMaxForTests(max?: number): void {
  scheduledNotifications.resetForTests(max)
  notificationDeliveryLedger.resetForTests(max)
}

export type NotificationPermissionState = {
  granted: boolean
  status: string
  canAskAgain: boolean
  authorizationReflectsUserChoice: boolean
}

export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  const { status, canAskAgain } = await Notifications.getPermissionsAsync()
  return {
    granted: status === 'granted',
    status,
    canAskAgain,
    // Why: Android <33 has no runtime notification permission, so "granted" is capability, not user consent.
    authorizationReflectsUserChoice:
      status === 'granted' && (Platform.OS !== 'android' || Number(Platform.Version) >= 33)
  }
}

// Why: re-read OS state every call — users can change it in Settings while Orca is backgrounded.
export async function ensureNotificationPermissions(): Promise<boolean> {
  const existing = await getNotificationPermissionState()
  if (existing.granted) {
    return true
  }
  const { status } = await Notifications.requestPermissionsAsync()
  return status === 'granted'
}

export function configureNotificationChannel(): void {
  if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync('orca-desktop', {
      name: 'Desktop Notifications',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250],
      lightColor: '#6366f1'
    })
  }
}

async function showLocalNotification(event: NotificationEvent, hostId: string): Promise<void> {
  const storedKey = event.notificationId
    ? getStoredNotificationKey(hostId, event.notificationId)
    : null
  if (!storedKey) {
    if (!(await loadPushNotificationsEnabled()) || !(await ensureNotificationPermissions())) {
      return
    }
    await scheduleLocalNotification(event, hostId)
    return
  }

  let state = scheduledNotifications.get(storedKey)
  let evictedIdentifiers: string[] = []
  if (state?.pending) {
    return
  }
  if (!state) {
    const reservation = scheduledNotifications.reserve(storedKey)
    if (!reservation) {
      return
    }
    state = reservation.state
    evictedIdentifiers = reservation.evictedIdentifiers
  }
  const notificationState = state
  const pending = scheduleTrackedNotification(event, hostId, notificationState, evictedIdentifiers)
  notificationState.pending = pending

  try {
    const scheduledIdentifier = await pending
    if (!scheduledIdentifier) {
      if (!notificationState.identifier) {
        scheduledNotifications.delete(storedKey)
      }
      return
    }
    if (notificationState.dismissAfterSchedule) {
      notificationState.dismissAfterSchedule = false
      scheduledNotifications.delete(storedKey)
      await Notifications.dismissNotificationAsync(scheduledIdentifier).catch(() => {})
      return
    }
    if (!scheduledNotifications.retainIdentifier(notificationState, scheduledIdentifier)) {
      scheduledNotifications.delete(storedKey)
      await Notifications.dismissNotificationAsync(scheduledIdentifier).catch(() => {})
    }
  } finally {
    if (notificationState.pending === pending) {
      notificationState.pending = undefined
      notificationState.dismissAfterSchedule = false
    }
  }
}

async function scheduleTrackedNotification(
  event: NotificationEvent,
  hostId: string,
  state: MobileScheduledNotificationState,
  evictedIdentifiers: string[]
): Promise<string | null> {
  // Why: retaining the native id makes a later desktop dismiss work; eviction must close it before slot reuse.
  for (const identifier of evictedIdentifiers) {
    await Notifications.dismissNotificationAsync(identifier).catch(() => {})
  }
  if (!(await loadPushNotificationsEnabled()) || !(await ensureNotificationPermissions())) {
    return null
  }
  if (state.identifier) {
    await Notifications.dismissNotificationAsync(state.identifier).catch(() => {})
    scheduledNotifications.clearIdentifier(state)
  }
  return scheduleLocalNotification(event, hostId)
}

function scheduleLocalNotification(event: NotificationEvent, hostId: string): Promise<string> {
  return Notifications.scheduleNotificationAsync({
    content: {
      title: event.title,
      body: event.body,
      data: buildLocalNotificationData(event, hostId),
      ...(Platform.OS === 'android' ? { channelId: 'orca-desktop' } : {})
    },
    trigger: null
  })
}

async function dismissLocalNotification(
  event: DismissNotificationEvent,
  hostId: string
): Promise<void> {
  const storedKey = getStoredNotificationKey(hostId, event.notificationId)
  const state = scheduledNotifications.get(storedKey)
  if (!state) {
    return
  }
  if (state.pending) {
    // Why: dismiss can arrive while the OS is still scheduling; defer it so no stale banner survives.
    state.dismissAfterSchedule = true
    return
  }
  if (!state.identifier) {
    return
  }
  scheduledNotifications.delete(storedKey)
  await Notifications.dismissNotificationAsync(state.identifier).catch(() => {})
}

export function startLocalNotificationDelivery(
  event: NotificationEvent | DismissNotificationEvent,
  hostId: string
): Promise<void> | null {
  const releaseDelivery = notificationDeliveryLedger.claim(event, hostId)
  if (!releaseDelivery) {
    return null
  }
  const delivery =
    event.type === 'notification'
      ? showLocalNotification(event, hostId)
      : dismissLocalNotification(event, hostId)
  return delivery.finally(() => {
    releaseDelivery()
  })
}
