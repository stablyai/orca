import { useRouter } from 'expo-router'
import { ListRow } from '../components/list/ListGroup'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
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
import {
  setComposerAgentIconPosition,
  useComposerAgentIconPosition
} from '../session/native-chat/preferences/composer-agent-icon-position'
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

function usageDisplayOptions(t: Translate): { value: UsagePercentageDisplay; label: string }[] {
  return [
    { value: 'used', label: t('settings.appearance.usage.used', 'Used') },
    { value: 'remaining', label: t('settings.appearance.usage.remaining', 'Remaining') }
  ]
}

export default function AppearanceSettingsScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const preference = useMobileAppearancePreference()
  const iconPosition = useComposerAgentIconPosition()
  const usageDisplay = useUsagePercentageDisplay()

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
        radioGroup
        title={t('settings.appearance.usage.heading', 'USAGE PERCENTAGES')}
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

      <SettingsSection
        radioGroup
        title={t('settings.appearance.agentIcon.heading', 'CHAT AGENT ICON')}
      >
        {(
          [
            ['model', t('settings.appearance.agentIcon.model', 'Next to model name')],
            ['field', t('settings.appearance.agentIcon.field', 'At start of message field')],
            ['off', t('settings.appearance.agentIcon.off', 'Off')]
          ] as const
        ).map(([value, label]) => (
          <ListRow
            key={value}
            title={label}
            selected={iconPosition === value}
            onPress={() => setComposerAgentIconPosition(value)}
          />
        ))}
      </SettingsSection>

      <UiLanguageSettingsSection />
    </SettingsScreen>
  )
}
