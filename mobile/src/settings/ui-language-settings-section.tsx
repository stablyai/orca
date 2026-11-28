import { useState } from 'react'
import { ListRow } from '../components/list/ListGroup'
import { PickerModal } from '../components/sheets/PickerModal'
import { SUPPORTED_UI_LOCALES } from '../../../src/shared/i18n/ui-locale'
import { UI_LANGUAGE_NATIVE_NAMES, UI_LANGUAGE_SYSTEM } from '../../../src/shared/i18n/ui-language'
import { isMobilePseudoLocalizationEnabled, setMobilePseudoLocalization } from '../i18n/mobile-i18n'
import {
  resolveMobileUiLocale,
  setMobileUiLanguagePreference,
  useMobileUiLanguagePreference,
  type MobileUiLanguagePreference
} from '../i18n/ui-language-preference'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsSection } from './settings-screen-frame'

const LANGUAGE_CHOICES: readonly MobileUiLanguagePreference[] = [
  UI_LANGUAGE_SYSTEM,
  ...SUPPORTED_UI_LOCALES
]
// Development-only layout check; never shipped.
const PSEUDO = 'pseudo'

/** One Language row; the eleven choices open in a picker instead of filling the page. */
export function UiLanguageSettingsSection() {
  const t = useMobileTranslation()
  const preference = useMobileUiLanguagePreference()
  const pseudo = isMobilePseudoLocalizationEnabled()
  const [pickerOpen, setPickerOpen] = useState(false)

  function label(choice: MobileUiLanguagePreference): string {
    if (choice !== UI_LANGUAGE_SYSTEM) {
      return UI_LANGUAGE_NATIVE_NAMES[choice]
    }
    return t('settings.appearance.language.systemWithCurrent', 'System ({{language}})', {
      language: UI_LANGUAGE_NATIVE_NAMES[resolveMobileUiLocale(UI_LANGUAGE_SYSTEM)]
    })
  }

  const options = [
    ...LANGUAGE_CHOICES.map((choice) => ({ value: choice, label: label(choice) })),
    ...(__DEV__
      ? [
          {
            value: PSEUDO,
            label: t('settings.uiLanguageSettingsSection.pseudoLanguage', 'Pseudo (en-XA)')
          }
        ]
      : [])
  ]
  const selected = pseudo ? PSEUDO : preference
  const title = t('settings.appearance.language.heading', 'Language')

  return (
    <>
      <SettingsSection
        footer={t(
          'settings.appearance.language.footer',
          'Permission prompts use the device language.'
        )}
      >
        <ListRow
          key="language"
          title={title}
          value={options.find((option) => option.value === selected)?.label}
          navigates
          onPress={() => setPickerOpen(true)}
        />
      </SettingsSection>
      <PickerModal<string>
        visible={pickerOpen}
        title={title}
        options={options}
        selected={selected}
        onSelect={(choice) => {
          const isPseudo = choice === PSEUDO
          setMobilePseudoLocalization(isPseudo)
          const next = LANGUAGE_CHOICES.find((option) => option === choice)
          void setMobileUiLanguagePreference(isPseudo ? 'en' : (next ?? UI_LANGUAGE_SYSTEM)).catch(
            () => {}
          )
        }}
        onClose={() => setPickerOpen(false)}
      />
    </>
  )
}
