import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import { loadPushNotificationsEnabled } from '../storage/preferences'

type NotificationEvent = {
  type: 'notification'
  source: 'agent-task-complete' | 'terminal-bell' | 'test'
  title: string
  body: string
  worktreeId?: string
}

type SubscribeResult = {
  type: 'ready'
  subscriptionId: string
}

export type NotificationPermissionState = {
  granted: boolean
  status: string
  canAskAgain: boolean
}

export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  const { status, canAskAgain } = await Notifications.getPermissionsAsync()
  return {
    granted: status === 'granted',
    status,
    canAskAgain
  }
}

// Why: permissions must be requested before scheduling any local notification.
// Read the OS state every time because users can change it in Settings while
// Orca remains alive in the background.
export async function ensureNotificationPermissions(): Promise<boolean> {
  const existing = await getNotificationPermissionState()
  if (existing.granted) {
    return true
  }

  const { status } = await Notifications.requestPermissionsAsync()
  return status === 'granted'
}

function configureNotificationChannel(): void {
  if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync('orca-desktop', {
      name: 'Desktop Notifications',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250],
      lightColor: '#6366f1'
    })
  }
}

async function showLocalNotification(event: NotificationEvent): Promise<void> {
  const enabled = await loadPushNotificationsEnabled()
  if (!enabled) return

  const granted = await ensureNotificationPermissions()
  if (!granted) return

  await Notifications.scheduleNotificationAsync({
    content: {
      title: event.title,
      body: event.body,
      data: { source: event.source, worktreeId: event.worktreeId },
      ...(Platform.OS === 'android' ? { channelId: 'orca-desktop' } : {})
    },
    trigger: null
  })
}

// Why: each host connection gets its own notification subscription. When the
// connection drops, the unsubscribe function cleans up the streaming RPC.
// Returns an unsubscribe function.
export function subscribeToDesktopNotifications(client: RpcClient): () => void {
  configureNotificationChannel()

  let subscriptionId: string | null = null
  let disposed = false
  function unsubscribeServer(id: string) {
    if (client.getState() === 'connected') {
      client.sendRequest('notifications.unsubscribe', { subscriptionId: id }).catch(() => {})
    }
  }

  const unsubscribeStream = client.subscribe('notifications.subscribe', {}, (data: unknown) => {
    const event = data as NotificationEvent | SubscribeResult | { type: 'end' }
    if (event.type === 'ready') {
      subscriptionId = (event as SubscribeResult).subscriptionId
      if (disposed) {
        unsubscribeServer(subscriptionId)
        unsubscribeStream()
      }
      return
    }
    if (event.type === 'end') {
      if (disposed) unsubscribeStream()
      return
    }
    if (disposed) return
    if (event.type === 'notification') {
      void showLocalNotification(event as NotificationEvent)
    }
  })

  return () => {
    disposed = true
    // Why: the client may already be closed when this cleanup runs (component
    // unmount races with disconnect). sendRequest rejects immediately on a
    // closed client — swallow it since server-side cleanup happens via
    // connection-close anyway.
    if (subscriptionId) {
      unsubscribeStream()
      unsubscribeServer(subscriptionId)
    }
  }
}
