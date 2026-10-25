export type NotificationTone = 'urgent' | 'complete'

export type NotificationDismissalFence = Readonly<{
  notificationEpoch?: string
  notificationSeq?: number
}>

export type InAppNotificationBannerItem = Readonly<{
  id: string
  tone: NotificationTone
  hostId?: string
  hostName: string
  title: string
  prompt?: string
  body: string
  worktreeId?: string
  paneKey?: string
  executionHost?: string
  notificationId?: string
  notificationEpoch?: string
  notificationSeq?: number
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

export function dismissInAppNotificationBannerById(
  notificationId: string,
  hostId?: string,
  fence?: NotificationDismissalFence
): void {
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
  const hasFence = Boolean(fence?.notificationEpoch) && fence?.notificationSeq !== undefined
  const bannerHasFence =
    Boolean(currentBanner.notificationEpoch) && currentBanner.notificationSeq !== undefined
  if (hasFence) {
    if (
      !bannerHasFence ||
      currentBanner.notificationEpoch !== fence?.notificationEpoch ||
      (currentBanner.notificationSeq ?? 0) > (fence?.notificationSeq ?? -1)
    ) {
      return
    }
  } else if (bannerHasFence) {
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
