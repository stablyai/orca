import { ListRow } from '../components/list/ListGroup'
import { SUPPORTED_UI_LOCALES } from '../../../src/shared/ui-locale'
import { UI_LANGUAGE_NATIVE_NAMES, UI_LANGUAGE_SYSTEM } from '../../../src/shared/ui-language'
import { isMobilePseudoLocalizationEnabled, setMobilePseudoLocalization } from '../i18n/mobile-i18n'
import {
  resolveMobileUiLocale,
  setMobileUiLanguagePreference,
  useMobileUiLanguagePreference,
  type MobileUiLanguagePreference
} from '../i18n/ui-language-preference'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsSection } from './settings-screen-frame'

const LANGUAGE_CHOICES: readonly MobileUiLanguagePreference[] = [
  UI_LANGUAGE_SYSTEM,
  ...SUPPORTED_UI_LOCALES
]

export function UiLanguageSettingsSection() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const preference = useMobileUiLanguagePreference()
  const pseudo = isMobilePseudoLocalizationEnabled()

  function label(choice: MobileUiLanguagePreference): string {
    if (choice !== UI_LANGUAGE_SYSTEM) {
      return UI_LANGUAGE_NATIVE_NAMES[choice]
    }
    return t('settings.appearance.language.systemWithCurrent', 'System ({{language}})', {
      language: UI_LANGUAGE_NATIVE_NAMES[resolveMobileUiLocale(UI_LANGUAGE_SYSTEM)]
    })
  }

  return (
    <SettingsSection
      radioGroup
      title={t('settings.appearance.language.heading', 'LANGUAGE')}
      footer={t(
        'settings.appearance.language.description',
        'System follows this device’s language. Permission prompts always use the device language.'
      )}
    >
      {LANGUAGE_CHOICES.map((choice) => (
        <ListRow
          key={choice}
          title={label(choice)}
          selected={preference === choice && !pseudo}
          onPress={() => {
            setMobilePseudoLocalization(false)
            void setMobileUiLanguagePreference(choice).catch(() => {})
          }}
        />
      ))}
      {/* Development-only layout check; never shipped. */}
      {__DEV__ ? (
        <ListRow
          key="pseudo"
          title={t('settings.uiLanguageSettingsSection.pseudoLanguage', 'Pseudo (en-XA)')}
          selected={pseudo}
          onPress={() => {
            setMobilePseudoLocalization(true)
            void setMobileUiLanguagePreference('en').catch(() => {})
          }}
        />
      ) : null}
    </SettingsSection>
  )
}
