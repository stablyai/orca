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
      <SettingsMenuSections push={push} openExternal={openExternal}>
        {children}
      </SettingsMenuSections>
    </SettingsScreen>
  )
}

/** The menu's groups without a screen around them, so Home's Settings tab can host them. */
export function SettingsMenuSections({
  push,
  openExternal,
  children
}: {
  push: (route: string) => void
  openExternal: (url: string) => Promise<unknown>
  children?: ReactNode
}) {
  const t = useMobileTranslation()
  return (
    <>
      <MobileSettingsSection first items={mobileSettingsMenuItems(push)} />

      {children}

      <MobileSettingsSection
        items={[
          {
            id: 'privacyPolicy',
            label: t('settings.menuScreen.privacyPolicy', 'Privacy Policy'),
            icon: Shield,
            external: true,
            onPress: () => void openExternal('https://orca.dev/privacy')
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
    </>
  )
}
