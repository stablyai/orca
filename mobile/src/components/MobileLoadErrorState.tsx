import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

/** A failed load: the message with its Retry button centered under it as one group. */
export function MobileLoadErrorState({
  message,
  onRetry
}: {
  message: string
  onRetry?: (() => void) | null
}) {
  return (
    <View style={styles.state}>
      <Text style={styles.errorText}>{message}</Text>
      {onRetry ? <MobileStateButton label="Retry" onPress={onRetry} /> : null}
    </View>
  )
}

/** The bordered action a centered load state offers, such as Retry. */
export function MobileStateButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.retryButton} onPress={onPress} accessibilityRole="button">
      <Text style={styles.retryText}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
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
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.lg
  },
  retryText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
