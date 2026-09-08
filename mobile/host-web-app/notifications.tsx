import { useRouter } from 'expo-router'
import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import NotificationsScreen from '../src/settings/notification-settings-screen'

export default function HostedNotificationsRoute() {
  const router = useRouter()
  const shell = useMobileWebNativeShell()
  if (!shell.client) {
    return null
  }
  return (
    <NotificationsScreen
      key={shell.context?.shellSessionId ?? 'pending'}
      operations={shell.client.native.settingsDevice}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
    />
  )
}
