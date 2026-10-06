export type DismissNotificationEvent = {
  type: 'dismiss'
  notificationId: string
  notificationSeq?: number
  notificationEpoch?: string
}
