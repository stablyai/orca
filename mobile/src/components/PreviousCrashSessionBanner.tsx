import { AlertTriangle, ChevronRight, X } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { previousSessionTitle } from '../diagnostics/mobile-crash-session'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export function PreviousCrashSessionBanner({
  endedAbnormally,
  onDismiss,
  onPress,
  style
}: {
  endedAbnormally: boolean
  onDismiss?: () => void
  onPress?: () => void
  style?: StyleProp<ViewStyle>
}) {
  const copy = (
    <View style={styles.copy}>
      <Text style={styles.title}>{previousSessionTitle(endedAbnormally)}</Text>
      <Text style={styles.description}>
        Crash diagnostics are available to copy and share with support.
      </Text>
      {onPress ? <Text style={styles.actionText}>View diagnostics</Text> : null}
    </View>
  )

  return (
    <View style={[styles.banner, style]} testID="previous-crash-session-banner">
      <AlertTriangle size={16} color={colors.statusAmber} />
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="View crash diagnostics"
          onPress={onPress}
          style={styles.open}
        >
          {copy}
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
      ) : (
        copy
      )}
      {onDismiss ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss crash diagnostics notice"
          hitSlop={spacing.sm}
          onPress={onDismiss}
          style={styles.dismiss}
        >
          <X size={16} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel
  },
  copy: {
    flex: 1,
    gap: spacing.xs
  },
  open: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  dismiss: {
    padding: spacing.xs
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  description: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 18
  },
  actionText: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
})
