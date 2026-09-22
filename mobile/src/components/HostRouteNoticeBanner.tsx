import { Pressable, StyleSheet, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'

/**
 * One dismissible line above the list, in two tones.
 *
 * `notice` is the default and stays monochrome: the host is healthy and the user's target simply
 * went away. `failure` is for an action that did not happen, which the list has to say without
 * taking the screen: color is for state, so it is one red rule and nothing else.
 */
export function HostRouteNoticeBanner({
  message,
  tone = 'notice',
  onDismiss
}: {
  message: string
  tone?: 'notice' | 'failure'
  onDismiss: () => void
}) {
  return (
    <View style={[styles.banner, tone === 'failure' && styles.failure]}>
      <Text style={styles.text}>{message}</Text>
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss notice"
        hitSlop={spacing.sm}
        style={styles.dismiss}
      >
        <X size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.bgPanel,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  failure: { borderBottomColor: colors.statusRed },
  text: { flex: 1, color: colors.textSecondary, fontSize: 13 },
  dismiss: { padding: spacing.xs }
})
