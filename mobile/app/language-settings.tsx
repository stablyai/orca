import { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Check, ChevronLeft, Globe } from 'lucide-react-native'

import { T } from '../src/i18n/T'
import { getI18n, resolveLanguage, type MobileUiLanguage } from '../src/i18n/init'
import { loadUiLanguage, saveUiLanguage } from '../src/storage/preferences'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'

const LANGUAGE_CHOICES: Array<{ value: MobileUiLanguage; label: string }> = [
  { value: 'system', label: 'Follow System' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文（简体）' }
]

export default function LanguageSettingsScreen(): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [lang, setLang] = useState<MobileUiLanguage>('system')

  useEffect(() => {
    void loadUiLanguage().then(setLang)
  }, [])

  const onPick = useCallback(async (next: MobileUiLanguage) => {
    setLang(next)
    await saveUiLanguage(next)
    const i18n = getI18n()
    await i18n.changeLanguage(resolveLanguage(next))
  }, [])

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <T style={styles.heading}>Language</T>
      </View>

      <View style={styles.section}>
        {LANGUAGE_CHOICES.map((choice, index) => (
          <View key={choice.value}>
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => void onPick(choice.value)}
            >
              <Globe size={16} color={colors.textSecondary} />
              <Text style={styles.rowLabel}>{choice.label}</Text>
              {lang === choice.value && <Check size={16} color={colors.textPrimary} />}
            </Pressable>
            {index < LANGUAGE_CHOICES.length - 1 && <View style={styles.separator} />}
          </View>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg,
    paddingTop: 0
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
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
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary,
    flex: 1
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
})
