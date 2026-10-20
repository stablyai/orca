import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

export function MobileNativeChatPromptSuggestion({
  text,
  onAccept,
  onDismiss
}: {
  text: string
  onAccept: () => void
  onDismiss: () => void
}) {
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Use suggestion: ${text}`}
        accessibilityHint="Fills the draft without sending"
        onPress={onAccept}
        style={styles.suggestion}
      >
        <Text style={styles.text} numberOfLines={1}>
          {text}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss suggestion"
        onPress={onDismiss}
        hitSlop={spacing.sm}
        style={styles.dismiss}
      >
        <Text style={styles.text}>×</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  suggestion: { flex: 1, padding: spacing.xs },
  dismiss: { padding: spacing.xs },
  text: { color: colors.textMuted, fontSize: typography.bodySize }
})
