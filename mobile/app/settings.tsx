import { Linking } from 'react-native'
import { useRouter } from 'expo-router'
import SettingsMenuScreen from '../src/settings/settings-menu-screen'
import { PendingCredentialCleanupCard } from '../src/settings/pending-credential-cleanup-card'
import { installedAppVersion, useAppUpdateState } from '../src/app-update/app-update-runtime'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'

export default function NativeSettingsRoute() {
  const router = useRouter()
  const t = useMobileTranslation()
  const update = useAppUpdateState()
  return (
    <SettingsMenuScreen
      push={(route) => router.push(route)}
      openExternal={(url) => Linking.openURL(url)}
      aboutValue={
        update.available
          ? t('settings.menuItems.updateAvailable', 'Update available')
          : (installedAppVersion ?? undefined)
      }
    >
      <PendingCredentialCleanupCard />
    </SettingsMenuScreen>
  )
}
