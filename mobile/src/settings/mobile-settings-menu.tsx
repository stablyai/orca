import type { ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function MobileSettingsFrame({
  children,
  onBack
}: {
  children: ReactNode
  onBack?: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
          style={styles.backButton}
          onPress={onBack ?? (() => router.back())}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{t('common.settings', 'Settings')}</Text>
      </View>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    </View>
  )
}

export type MobileSettingsMenuItem = {
  id: string
  label: string
  icon: LucideIcon
  onPress: () => void
  external?: boolean
  disabled?: boolean
}

export function MobileSettingsSection({
  items,
  spaced = false
}: {
  items: MobileSettingsMenuItem[]
  spaced?: boolean
}) {
  useMobileColorScheme()
  return (
    <View style={[styles.section, spaced && styles.sectionSpacer]}>
      {items.map(({ id, label, icon: Icon, onPress, external, disabled }, index) => (
        <View key={id}>
          {index > 0 && <View style={styles.separator} />}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled: Boolean(disabled) }}
            disabled={disabled}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={onPress}
          >
            <Icon size={16} color={colors.textSecondary} />
            <Text style={styles.rowLabel}>{label}</Text>
            {!external && <ChevronRight size={16} color={colors.textMuted} />}
          </Pressable>
        </View>
      ))}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase, paddingHorizontal: spacing.lg },
  topRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: { fontSize: 20, fontWeight: '700', color: colors.textPrimary },
  section: { backgroundColor: colors.bgPanel, borderRadius: radii.surface, overflow: 'hidden' },
  sectionSpacer: { marginTop: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  rowLabel: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
}))
