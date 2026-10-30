import { requireOptionalNativeModule } from 'expo-modules-core'

export type LiveAlertsCapabilities = {
  sdkInt: number
  notificationsEnabled: boolean
  /** Android 16 (API 36) or newer, where the Live Update (promoted notification) APIs exist. */
  promotionApi: boolean
  /** NotificationManager.canPostPromotedNotifications(): the user still allows Orca's Live Updates. */
  canPostPromoted: boolean
}

/** How `show` posted the notification; `unavailable` means notifications are off or the JSON was bad. */
export type LiveAlertShowResult = 'foreground-service' | 'notification-only' | 'unavailable'

type OrcaLiveAlertsEvents = {
  /** A tap on the live notification while the app was running; `target` is its JSON target. */
  onOpenTarget: (event: { target: string }) => void
  /** The user swiped the notification away or pressed Hide; the service has already stopped. */
  onDismissed: () => void
  /** Every 3 s while the foreground service runs, even when JavaScript timers are paused. */
  onTick: () => void
}

type OrcaLiveAlertsNativeModule = {
  /** Subscribes to one of the events above; `remove()` on the result unsubscribes. */
  addListener<EventName extends keyof OrcaLiveAlertsEvents>(
    eventName: EventName,
    listener: OrcaLiveAlertsEvents[EventName]
  ): { remove(): void }
  getCapabilities(): LiveAlertsCapabilities
  /** Posts or updates the live notification from live-alert-payload.ts JSON. */
  show(payloadJson: string): Promise<LiveAlertShowResult>
  /** Ends the live notification, leaving `payloadJson` as a dismissable one when given. */
  finish(payloadJson: string | null): Promise<void>
  cancel(): Promise<void>
  /** The notification target the activity was launched with, removed once read. */
  consumeLaunchTarget(): string | null
  openPromotionSettings(): void
  openAppNotificationSettings(): void
  openAppDetailsSettings(): void
}

/** Null on iOS, on the web and in builds made before the module existed. */
export const OrcaLiveAlerts =
  requireOptionalNativeModule<OrcaLiveAlertsNativeModule>('OrcaLiveAlerts')
