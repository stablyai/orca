import { Pressable, StyleSheet, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'

/**
 * One dismissible line above the list, in two tones.
 *
 * `notice` is the default and stays monochrome: the host is healthy and the user's target simply
 * went away. `failure` is for an action that did not happen, which the list has to say without
 * taking the screen: color is for state, so it is one red rule and nothing else.
 *
 * Both are inserted into a screen that is already on screen, so a reader who has moved past the top
 * of the list never arrives at one. The tone decides how loudly it is carried to them: a refusal
 * interrupts, and a bounced route waits its turn, because interrupting for the second would train
 * people to ignore the first. `alert` only for the refusal, and no role for the other — React
 * Native has no `status` role, so the polite region is the whole of that answer.
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
    <View
      style={[styles.banner, tone === 'failure' && styles.failure]}
      accessibilityRole={tone === 'failure' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'failure' ? 'assertive' : 'polite'}
    >
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
