import { StyleSheet, Text, View } from 'react-native'
import { RotateCcw } from 'lucide-react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { Button } from './ui/Button'
import type { CodexResetCreditSummary } from './codex-reset-credit'

/** The last row of the Codex group: what reset is available, and a secondary button to use it. */
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
    <View style={styles.row}>
      <View style={styles.copy}>
        <Text style={styles.title}>{summary.availabilityLabel}</Text>
        <Text style={styles.subtitle}>
          {[summary.expiryLabel, scopeLabel].filter(Boolean).join(' · ') ||
            'Earned Codex rate-limit reset'}
        </Text>
      </View>
      <Button
        label={busy ? 'Resetting…' : 'Use reset'}
        icon={RotateCcw}
        size="compact"
        variant="secondary"
        busy={busy}
        disabled={disabled}
        onPress={onPress}
        accessibilityLabel={busy ? 'Resetting Codex rate limits' : 'Use Codex rate-limit reset'}
        accessibilityHint={
          scopeLabel
            ? `Uses one earned reset for ${scopeLabel}`
            : 'Uses one earned reset for the active Codex account'
        }
      />
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  title: {
    ...textStyles.body,
    fontWeight: '500',
    color: colors.textPrimary
  },
  subtitle: {
    ...textStyles.subhead,
    color: colors.textSecondary
  }
})
