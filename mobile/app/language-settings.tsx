import { useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Check, ChevronLeft } from 'lucide-react-native'
import type { MobileLocale } from '../src/localization/mobile-locale'
import { useMobileLocale } from '../src/localization/mobile-locale-provider'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'

export default function LanguageSettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { locale, setLocale, t } = useMobileLocale()
  const [savingLocale, setSavingLocale] = useState<MobileLocale | null>(null)

  async function selectLocale(nextLocale: MobileLocale) {
    if (savingLocale) {
      return
    }
    setSavingLocale(nextLocale)
    try {
      await setLocale(nextLocale)
    } catch {
      Alert.alert(t('language.saveFailedTitle'), t('language.saveFailedBody'))
    } finally {
      setSavingLocale(null)
    }
  }

  const options: Array<{ locale: MobileLocale; label: string }> = [
    { locale: 'en', label: t('language.english') },
    { locale: 'zh-CN', label: t('language.simplifiedChinese') }
  ]

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityLabel={t('common.back')}
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{t('language.title')}</Text>
      </View>

      <Text style={styles.description}>{t('language.description')}</Text>
      <View style={styles.section}>
        {options.map((option, index) => {
          const selected = option.locale === locale
          const saving = option.locale === savingLocale
          return (
            <View key={option.locale}>
              {index > 0 ? <View style={styles.separator} /> : null}
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: savingLocale != null }}
                disabled={savingLocale != null}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => void selectLocale(option.locale)}
              >
                <Text style={styles.rowLabel}>{option.label}</Text>
                {saving ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : selected ? (
                  <Check size={18} color={colors.textPrimary} />
                ) : null}
              </Pressable>
            </View>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: {
    fontSize: typography.titleSize,
    fontWeight: '700',
    color: colors.textPrimary
  },
  description: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: 18,
    marginBottom: spacing.md
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowLabel: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.md + 2
  }
})
