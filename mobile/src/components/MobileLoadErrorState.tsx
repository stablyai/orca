import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

/** A failed load: the message with its Retry button centered under it as one group. */
export function MobileLoadErrorState({
  message,
  onRetry
}: {
  message: string
  onRetry?: (() => void) | null
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <View style={styles.state}>
      <Text style={styles.errorText}>{message}</Text>
      {onRetry ? <MobileStateButton label={t('common.retry', 'Retry')} onPress={onRetry} /> : null}
    </View>
  )
}

/** The bordered action a centered load state offers, such as Retry. */
export function MobileStateButton({ label, onPress }: { label: string; onPress: () => void }) {
  useMobileColorScheme()
  return (
    <Pressable style={styles.retryButton} onPress={onPress} accessibilityRole="button">
      <Text style={styles.retryText}>{label}</Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xl
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    textAlign: 'center'
  },
  retryButton: {
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.lg
  },
  retryText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
}))
