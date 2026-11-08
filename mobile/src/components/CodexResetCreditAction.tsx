import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native'
import { RotateCcw } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { CodexResetCreditSummary } from './codex-reset-credit'
import { ListRow } from './list/ListGroup'

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
    <ListRow
      title={summary.availabilityLabel}
      subtitle={
        [summary.expiryLabel, scopeLabel].filter(Boolean).join(' · ') ||
        t('components.codexResetCreditAction.earnedReset', 'Earned Codex rate-limit reset')
      }
      accessory={
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
      }
    />
  )
}

const styles = themedStyleSheet(() => ({
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
    opacity: feedback.pressedOpacity
  },
  buttonDisabled: {
    opacity: feedback.disabledOpacity
  },
  buttonText: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary
  }
}))
