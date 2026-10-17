import { useMobileTheme } from '../src/theme/use-mobile-theme'
import { NotificationDisplayTest } from '../src/settings/notification-display-test'
import { NativeNotificationDeliverySettings } from '../src/settings/native-notification-delivery-settings'
import { useRouter } from 'expo-router'
import NotificationsScreen from '../src/settings/notification-settings-screen'
import { nativeNotificationSettingsOperations } from '../src/settings/native-notification-settings-operations'
export default function NativeNotificationsRoute() {
  useMobileTheme()

  const router = useRouter()
  return (
    <NotificationsScreen
      operations={nativeNotificationSettingsOperations}
      onBack={() => router.back()}
      description="Get agent alerts even when the app is closed. Delivered through Orca’s push service and Apple or Google."
    >
      {(enabled) => (
        <>
          <NativeNotificationDeliverySettings enabled={enabled} />
          <NotificationDisplayTest onTroubleshoot={() => router.push('/troubleshoot')} />
        </>
      )}
    </NotificationsScreen>
  )
}
