import type { ReactNode } from 'react'
import { useRouter } from 'expo-router'
import { MobileSettingsSection } from './mobile-settings-menu'
import { mobileSettingsMenuGroups } from './mobile-settings-menu-items'
import { SettingsScreen } from './settings-screen-frame'
import { appearanceOptions } from './appearance-settings-screen'
import { useMobileAppearancePreference } from '../theme/mobile-appearance'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export default function SettingsMenuScreen({
  push,
  onBack,
  openExternal,
  aboutValue,
  children
}: {
  push: (route: string) => void
  onBack?: () => void
  openExternal: (url: string) => Promise<unknown>
  /** About's row value: the installed version, or that an update is out. */
  aboutValue?: string
  /** Notices that need the user, between the surfaces and help. */
  children?: ReactNode
}) {
  const t = useMobileTranslation()
  const router = useRouter()
  const preference = useMobileAppearancePreference()
  const [looks, surfaces, help] = mobileSettingsMenuGroups({
    push,
    openExternal: (url) => void openExternal(url),
    appearanceValue: appearanceOptions(t).find((option) => option.value === preference)?.label,
    aboutValue
  })
  return (
    <SettingsScreen
      title={t('common.settings', 'Settings')}
      onBack={onBack ?? (() => router.back())}
    >
      <MobileSettingsSection first items={looks} />
      <MobileSettingsSection items={surfaces} />
      {children}
      <MobileSettingsSection items={help} />
    </SettingsScreen>
  )
}
