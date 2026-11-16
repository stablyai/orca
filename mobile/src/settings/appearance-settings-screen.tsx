import { useRouter } from 'expo-router'
import { ListRow } from '../components/list/ListGroup'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  setMobileAppearancePreference,
  useMobileAppearancePreference,
  type MobileAppearancePreference
} from '../theme/mobile-appearance'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsScreen, SettingsSection } from './settings-screen-frame'
import { UiLanguageSettingsSection } from './ui-language-settings-section'

function appearanceOptions(t: Translate): { value: MobileAppearancePreference; label: string }[] {
  return [
    { value: 'system', label: t('settings.appearance.theme.system', 'System') },
    { value: 'light', label: t('settings.appearance.theme.light', 'Light') },
    { value: 'dark', label: t('settings.appearance.theme.dark', 'Dark') }
  ]
}

export default function AppearanceSettingsScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const preference = useMobileAppearancePreference()

  return (
    <SettingsScreen
      title={t('settings.appearance.title', 'Appearance')}
      onBack={() => router.back()}
    >
      <SettingsSection
        first
        radioGroup
        title={t('settings.appearance.theme.heading', 'THEME')}
        footer={t(
          'settings.appearance.theme.description',
          'System follows this device’s light or dark setting.'
        )}
      >
        {appearanceOptions(t).map(({ value, label }) => (
          <ListRow
            key={value}
            title={label}
            selected={preference === value}
            onPress={() => {
              void setMobileAppearancePreference(value).catch(() => {})
            }}
          />
        ))}
      </SettingsSection>

      <UiLanguageSettingsSection />
    </SettingsScreen>
  )
}
