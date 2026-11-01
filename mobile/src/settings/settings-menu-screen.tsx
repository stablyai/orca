import type { ReactNode } from 'react'
import { useRouter } from 'expo-router'
import { Shield, LifeBuoy } from 'lucide-react-native'
import { MobileSettingsSection } from './mobile-settings-menu'
import { mobileSettingsMenuItems } from './mobile-settings-menu-items'
import { SettingsScreen } from './settings-screen-frame'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export default function SettingsMenuScreen({
  push,
  onBack,
  openExternal,
  children
}: {
  push: (route: string) => void
  onBack?: () => void
  openExternal: (url: string) => Promise<unknown>
  children?: ReactNode
}) {
  const t = useMobileTranslation()
  const router = useRouter()
  return (
    <SettingsScreen
      title={t('common.settings', 'Settings')}
      onBack={onBack ?? (() => router.back())}
    >
      <MobileSettingsSection first items={mobileSettingsMenuItems(push)} />

      {children}

      <MobileSettingsSection
        items={[
          {
            id: 'privacyPolicy',
            label: t('settings.menuScreen.privacyPolicy', 'Privacy Policy'),
            icon: Shield,
            external: true,
            onPress: () => void openExternal('https://www.onorca.dev/privacy')
          },
          {
            id: 'support',
            label: t('settings.menuScreen.support', 'Support'),
            icon: LifeBuoy,
            external: true,
            onPress: () => void openExternal('https://github.com/stablyai/orca/issues')
          }
        ]}
      />
    </SettingsScreen>
  )
}
