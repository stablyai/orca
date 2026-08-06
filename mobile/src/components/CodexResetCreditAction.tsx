import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { RotateCcw } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { CodexResetCreditSummary } from './codex-reset-credit'
import { t } from '@/i18n/mobile-i18n'

export function CodexResetCreditAction({
  summary,
  scopeLabel,
  busy,
  disabled,
  onPress
}: {
  summary: CodexResetCreditSummary
  scopeLabel?: string | null
  busy: boolean
  disabled: boolean
  onPress: () => void
}) {
  return (
    <>
      <View style={styles.separator} />
      <View style={styles.row}>
        <View style={styles.copy}>
          <Text style={styles.title}>{summary.availabilityLabel}</Text>
          <Text style={styles.subtitle}>
            {[summary.expiryLabel, scopeLabel].filter(Boolean).join(' · ') ||
              t('codexResetCreditAction.earned')}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.button,
            disabled && styles.buttonDisabled,
            pressed && !disabled && styles.buttonPressed
          ]}
          onPress={onPress}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={
            busy ? t('codexResetCreditAction.resettingCodex') : t('codexResetCreditAction.useCodex')
          }
          accessibilityHint={
            scopeLabel
              ? t('codexResetCreditAction.usesOneEarnedResetScope', {
                  scopeLabel: scopeLabel
                })
              : t('codexResetCreditAction.usesOneEarnedResetActive')
          }
          accessibilityState={{ busy, disabled }}
          hitSlop={8}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <RotateCcw size={14} color={colors.textPrimary} />
          )}
          <Text style={styles.buttonText}>
            {busy ? t('codexResetCreditAction.resetting') : t('codexResetCreditAction.useReset')}
          </Text>
        </Pressable>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  copy: {
    flex: 1,
    gap: spacing.xs
  },
  title: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  subtitle: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  button: {
    minHeight: 44,
    width: 104,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  buttonPressed: {
    opacity: 0.72
  },
  buttonDisabled: {
    opacity: 0.5
  },
  buttonText: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary
  }
})
