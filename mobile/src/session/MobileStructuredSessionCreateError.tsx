import { AlertTriangle, X } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, spacing } from '../theme/mobile-theme'

export function MobileStructuredSessionCreateError({
  message,
  onDismiss
}: {
  message: string
  onDismiss: () => void
}) {
  if (!message) {
    return null
  }
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <AlertTriangle size={16} color={colors.statusRed} strokeWidth={2.2} />
      <Text style={styles.message}>{message}</Text>
      <Pressable
        style={styles.dismiss}
        onPress={onDismiss}
        accessibilityLabel="Dismiss chat session creation error"
        hitSlop={8}
      >
        <X size={16} color={colors.textMuted} strokeWidth={2.2} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  message: {
    flex: 1,
    color: colors.statusRed,
    fontSize: 12,
    lineHeight: 16
  },
  dismiss: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -4
  }
})
