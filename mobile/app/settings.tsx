import { Linking } from 'react-native'
import { useRouter } from 'expo-router'
import SettingsMenuScreen from '../src/settings/settings-menu-screen'
import { PendingCredentialCleanupCard } from '../src/settings/pending-credential-cleanup-card'
import { SettingsAppUpdateSection } from '../src/settings/settings-app-update-section'

export default function NativeSettingsRoute() {
  const router = useRouter()
  return (
    <SettingsMenuScreen
      push={(route) => router.push(route)}
      openExternal={(url) => Linking.openURL(url)}
    >
      <SettingsAppUpdateSection />
      <PendingCredentialCleanupCard />
    </SettingsMenuScreen>
  )
}
