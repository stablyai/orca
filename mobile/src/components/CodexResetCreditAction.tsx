import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { RotateCcw } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { CodexResetCreditSummary } from './codex-reset-credit'

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
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <>
      <View style={styles.separator} />
      <View style={styles.row}>
        <View style={styles.copy}>
          <Text style={styles.title}>{summary.availabilityLabel}</Text>
          <Text style={styles.subtitle}>
            {[summary.expiryLabel, scopeLabel].filter(Boolean).join(' · ') ||
              t('components.codexResetCreditAction.earnedReset', 'Earned Codex rate-limit reset')}
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
            busy
              ? t('components.codexResetCreditAction.resettingLabel', 'Resetting Codex rate limits')
              : t('components.codexResetCreditAction.useResetLabel', 'Use Codex rate-limit reset')
          }
          accessibilityHint={
            scopeLabel
              ? t(
                  'components.codexResetCreditAction.scopedHint',
                  'Uses one earned reset for {{scopeLabel}}',
                  { scopeLabel }
                )
              : t(
                  'components.codexResetCreditAction.activeAccountHint',
                  'Uses one earned reset for the active Codex account'
                )
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
            {busy
              ? t('components.codexResetCreditAction.resetting', 'Resetting…')
              : t('components.codexResetCreditAction.useReset', 'Use reset')}
          </Text>
        </Pressable>
      </View>
    </>
  )
}

const styles = themedStyleSheet(() => ({
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
    borderRadius: radii.control,
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
}))
