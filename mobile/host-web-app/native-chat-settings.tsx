import { useRouter } from 'expo-router'
import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import NativeChatSettingsScreen from '../src/settings/native-chat-settings-screen'

export default function HostedChatSettingsRoute() {
  const router = useRouter()
  const shell = useMobileWebNativeShell()
  return (
    <NativeChatSettingsScreen
      key={shell.context?.shellSessionId ?? 'pending'}
      onBack={() => {
        if (router.canGoBack()) {
          router.back()
        } else {
          router.replace('/settings')
        }
      }}
      scope="host"
      available={shell.client?.native.supports('pagePreferences') ?? false}
    />
  )
}
