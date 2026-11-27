import { useRouter } from 'expo-router'
import { ListRow } from '../components/list/ListGroup'
import {
  setMobileAppearancePreference,
  useMobileAppearancePreference,
  type MobileAppearancePreference
} from '../theme/mobile-appearance'
import type { UsagePercentageDisplay } from '../../../src/shared/agent-usage/display/usage-percentage-display'
import {
  setUsagePercentageDisplay,
  useUsagePercentageDisplay
} from '../accounts/usage/usage-percentage-display-preference'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsScreen, SettingsSection } from './settings-screen-frame'
import { UiLanguageSettingsSection } from './ui-language-settings-section'

export function appearanceOptions(
  t: Translate
): { value: MobileAppearancePreference; label: string }[] {
  return [
    { value: 'system', label: t('settings.appearance.theme.system', 'System') },
    { value: 'light', label: t('settings.appearance.theme.light', 'Light') },
    { value: 'dark', label: t('settings.appearance.theme.dark', 'Dark') }
  ]
}

function usageDisplayOptions(t: Translate): { value: UsagePercentageDisplay; label: string }[] {
  return [
    { value: 'used', label: t('settings.appearance.usage.used', 'Used') },
    { value: 'remaining', label: t('settings.appearance.usage.remaining', 'Remaining') }
  ]
}

export default function AppearanceSettingsScreen() {
  const t = useMobileTranslation()
  const router = useRouter()
  const preference = useMobileAppearancePreference()
  const usageDisplay = useUsagePercentageDisplay()

  return (
    <SettingsScreen
      title={t('settings.appearance.title', 'Appearance')}
      onBack={() => router.back()}
    >
      <SettingsSection
        first
        radioGroup
        title={t('settings.appearance.theme.heading', 'Theme')}
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
        radioGroup
        title={t('settings.appearance.usage.heading', 'Usage percentages')}
        footer={t(
          'settings.appearance.usage.description',
          'Usage bars on Home and Accounts show how much of each limit is used or left. Saved on this phone.'
        )}
      >
        {usageDisplayOptions(t).map(({ value, label }) => (
          <ListRow
            key={value}
            title={label}
            selected={usageDisplay === value}
            onPress={() => setUsagePercentageDisplay(value)}
          />
        ))}
      </SettingsSection>

      <UiLanguageSettingsSection />
    </SettingsScreen>
  )
}
