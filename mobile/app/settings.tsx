import { Linking } from 'react-native'
import { useRouter } from 'expo-router'
import SettingsMenuScreen from '../src/settings/settings-menu-screen'
import { PendingCredentialCleanupCard } from '../src/settings/pending-credential-cleanup-card'

export default function NativeSettingsRoute() {
  const router = useRouter()
  return (
    <SettingsMenuScreen
      push={(route) => router.push(route)}
      openExternal={(url) => Linking.openURL(url)}
    >
      <PendingCredentialCleanupCard />
    </SettingsMenuScreen>
  )
}
