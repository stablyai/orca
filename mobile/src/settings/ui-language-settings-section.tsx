import { Pressable, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
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
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { appearanceSettingsStyles as styles } from './appearance-settings-styles'

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
    <>
      <Text style={[styles.groupHeading, styles.groupHeadingSpaced]}>
        {t('settings.appearance.language.heading', 'LANGUAGE')}
      </Text>
      <Text style={styles.groupDescription}>
        {t(
          'settings.appearance.language.description',
          'System follows this device’s language. Permission prompts always use the device language.'
        )}
      </Text>
      <View style={[styles.section, styles.sectionTopGap]} accessibilityRole="radiogroup">
        {LANGUAGE_CHOICES.map((choice, index) => {
          const selected = preference === choice && !pseudo
          return (
            <View key={choice}>
              {index > 0 && <View style={styles.separator} />}
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => {
                  setMobilePseudoLocalization(false)
                  void setMobileUiLanguagePreference(choice).catch(() => {})
                }}
              >
                <Text style={styles.rowLabel}>{label(choice)}</Text>
                {selected && <Check size={18} color={colors.textPrimary} />}
              </Pressable>
            </View>
          )
        })}
        {__DEV__ && (
          <View>
            <View style={styles.separator} />
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: pseudo }}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => {
                setMobilePseudoLocalization(true)
                void setMobileUiLanguagePreference('en').catch(() => {})
              }}
            >
              {/* Development-only layout check; never shipped. */}
              <Text style={styles.rowLabel}>
                {t('settings.uiLanguageSettingsSection.pseudoLanguage', 'Pseudo (en-XA)')}
              </Text>
              {pseudo && <Check size={18} color={colors.textPrimary} />}
            </Pressable>
          </View>
        )}
      </View>
    </>
  )
}
