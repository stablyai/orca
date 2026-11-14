import { useRouter } from 'expo-router'
import { Linking, ScrollView } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { PendingCredentialCleanupCard } from '../../settings/pending-credential-cleanup-card'
import { SettingsAppUpdateSection } from '../../settings/settings-app-update-section'
import { SettingsMenuSections } from '../../settings/settings-menu-screen'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { MobileHomeTabHeader } from './MobileHomeTabHeader'

/** The Settings menu as Home's last tab; its rows push the same settings screens as before. */
export function MobileHomeSettingsTab(props: { bottomInset: number }) {
  const t = useMobileTranslation()
  const router = useRouter()
  return (
    <>
      <MobileHomeTabHeader title={t('common.settings', 'Settings')} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: props.bottomInset }]}
        showsVerticalScrollIndicator={false}
      >
        <SettingsMenuSections
          push={(route) => router.push(route)}
          openExternal={(url) => Linking.openURL(url)}
        >
          <SettingsAppUpdateSection />
          <PendingCredentialCleanupCard />
        </SettingsMenuSections>
      </ScrollView>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm }
}))
