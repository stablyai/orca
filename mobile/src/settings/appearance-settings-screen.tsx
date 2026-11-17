import { useRouter } from 'expo-router'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { setScreenAwakePreference, useScreenAwakePreference } from './mobile-screen-awake'
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
  const screenAwake = useScreenAwakePreference()
  const screenAwakeLabel = t('settings.appearance.keepScreenAwake', 'Keep screen awake')

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

      <SettingsSection
        title={t('settings.appearance.screenHeading', 'SCREEN')}
        footer={t(
          'settings.appearance.keepScreenAwakeDescription',
          'Keep the screen on while Orca is open.'
        )}
      >
        <ListRow
          title={screenAwakeLabel}
          accessory={
            <MobileSwitch
              accessibilityLabel={screenAwakeLabel}
              value={screenAwake}
              onValueChange={(value) => {
                void setScreenAwakePreference(value).catch(() => {})
              }}
            />
          }
        />
      </SettingsSection>

      <UiLanguageSettingsSection />
    </SettingsScreen>
  )
}
