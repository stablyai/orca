import { View, Text, Pressable, ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Check, ChevronLeft } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { appearanceSettingsStyles as styles } from './appearance-settings-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  setMobileAppearancePreference,
  useMobileAppearancePreference,
  type MobileAppearancePreference
} from '../theme/mobile-appearance'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
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
  const insets = useSafeAreaInsets()
  const preference = useMobileAppearancePreference()

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{t('settings.appearance.title', 'Appearance')}</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.groupHeading}>{t('settings.appearance.theme.heading', 'THEME')}</Text>
        <Text style={styles.groupDescription}>
          {t(
            'settings.appearance.theme.description',
            'System follows this device’s light or dark setting.'
          )}
        </Text>
        <View style={[styles.section, styles.sectionTopGap]} accessibilityRole="radiogroup">
          {appearanceOptions(t).map(({ value, label }, index) => {
            const selected = preference === value
            return (
              <View key={value}>
                {index > 0 && <View style={styles.separator} />}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={() => {
                    void setMobileAppearancePreference(value).catch(() => {})
                  }}
                >
                  <Text style={styles.rowLabel}>{label}</Text>
                  {selected && <Check size={18} color={colors.textPrimary} />}
                </Pressable>
              </View>
            )
          })}
        </View>

        <UiLanguageSettingsSection />
      </ScrollView>
    </View>
  )
}
