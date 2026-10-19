export type DismissNotificationEvent = {
  type: 'dismiss'
  notificationId: string
  notificationSeq?: number
  notificationEpoch?: string
  dismissedDelivery?: {
    notificationId: string
    notificationEpoch: string
    notificationSeq: number
  }
}
