export type NotificationTone = 'urgent' | 'complete'

export type InAppNotificationBannerItem = Readonly<{
  id: string
  tone: NotificationTone
  hostId?: string
  hostName: string
  title: string
  body: string
  worktreeId?: string
  paneKey?: string
  executionHost?: string
  notificationId?: string
  osNotificationIdentifier?: string
  createdAt: number
}>

type Listener = () => void

let currentBanner: InAppNotificationBannerItem | null = null
const listeners = new Set<Listener>()

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function getCurrentInAppNotificationBanner(): InAppNotificationBannerItem | null {
  return currentBanner
}

export function publishInAppNotificationBanner(item: InAppNotificationBannerItem): void {
  currentBanner = item
  notifyListeners()
}

export function dismissInAppNotificationBanner(id?: string): void {
  if (!currentBanner) {
    return
  }
  if (id !== undefined && currentBanner.id !== id) {
    return
  }
  currentBanner = null
  notifyListeners()
}

export function dismissInAppNotificationBannerById(notificationId: string, hostId?: string): void {
  if (!currentBanner) {
    return
  }
  if (currentBanner.notificationId !== notificationId) {
    return
  }
  if (
    hostId !== undefined &&
    currentBanner.hostId !== undefined &&
    currentBanner.hostId !== hostId
  ) {
    return
  }
  currentBanner = null
  notifyListeners()
}

export function subscribeInAppNotificationBanner(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetInAppNotificationBannerForTests(): void {
  currentBanner = null
  listeners.clear()
}
