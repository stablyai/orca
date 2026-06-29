import { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Check, ChevronLeft, Globe } from 'lucide-react-native'

import { useTranslate } from '../src/i18n/useTranslate'
import { getI18n, resolveLanguage, type MobileUiLanguage } from '../src/i18n/init'
import { loadUiLanguage, saveUiLanguage } from '../src/storage/preferences'
import { colors, spacing, typography } from '../src/theme/mobile-theme'

// Why: language pickers must NOT translate their own labels — the user
// needs to see the language name in its native script to recognize it.
const LANGUAGE_CHOICES: ReadonlyArray<{ value: MobileUiLanguage; label: string }> = [
  { value: 'system', label: 'Follow System' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文（简体）' }
]

export default function LanguageSettingsScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { t } = useTranslate()
  const [lang, setLang] = useState<MobileUiLanguage>('system')
  // Why: sequential taps would race — the first tap's setLang + changeLanguage
  // would resolve after the second tap's, leaving the UI in option 1 state
  // but i18n in option 2. Disable the row while a pick is in flight so only
  // one language switch is ever pending.
  const [pending, setPending] = useState<MobileUiLanguage | null>(null)

  useEffect(() => {
    void loadUiLanguage().then(setLang)
  }, [])

  const onPick = useCallback(
    async (next: MobileUiLanguage) => {
      if (pending) {
        return
      }
      setPending(next)
      setLang(next) // 立即更新 UI
      try {
        // Why: saveUiLanguage is best-effort persistence. Blocking the UI
        // switch on a failing write makes the user think the tap did nothing.
        void saveUiLanguage(next)
        await getI18n().changeLanguage(resolveLanguage(next))
      } finally {
        setPending(null)
      }
    },
    [pending]
  )

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{t('mobile.language.title', 'Language')}</Text>
      </View>

      <View style={styles.section}>
        {LANGUAGE_CHOICES.map((choice, index) => (
          <View key={choice.value}>
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              // Why: disabled=true during a pending switch prevents the
              // double-tap race where two changeLanguage calls interleave and
              // leave the UI state and the i18n state out of sync.
              disabled={pending !== null}
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
  container: { flex: 1, backgroundColor: colors.bgBase },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md
  },
  backButton: { padding: spacing.xs, marginRight: spacing.sm },
  heading: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  section: {
    marginHorizontal: spacing.md,
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: spacing.sm
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowLabel: {
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    flex: 1
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.md
  }
})
