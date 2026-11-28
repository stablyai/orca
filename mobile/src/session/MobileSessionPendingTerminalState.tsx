import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'

const pendingTerminalStylesSheet = themedStyleSheet((colors) => ({
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    marginBottom: spacing.lg
  },
  createButton: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.control
  },
  createButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  newTerminalButtonPressed: {
    backgroundColor: colors.bgRaised
  }
}))

export function MobileSessionPendingTerminalState({
  title,
  parked,
  onRetry
}: {
  title: string | undefined
  parked: boolean
  onRetry: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const styles = useThemedStyles(pendingTerminalStylesSheet)
  return (
    <View style={styles.emptyState}>
      {!parked && <ActivityIndicator size="small" color={colors.textSecondary} />}
      <Text style={styles.emptyText}>
        {parked
          ? t(
              'session.activeContent.terminalTakingLonger',
              'Terminal is taking longer than expected'
            )
          : title || t('session.activeContent.loadingTerminal', 'Loading terminal')}
      </Text>
      {parked && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(
            'session.activeContent.retryLoadingTerminal',
            'Retry loading terminal'
          )}
          style={({ pressed }) => [styles.createButton, pressed && styles.newTerminalButtonPressed]}
          onPress={onRetry}
        >
          <Text style={styles.createButtonText}>{t('common.retry', 'Retry')}</Text>
        </Pressable>
      )}
    </View>
  )
}
