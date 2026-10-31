import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type Props = {
  /** Omitted while loading, which shows a spinner instead. */
  icon?: LucideIcon
  title: string
  message?: string
  action?: { label: string; onPress: () => void }
  loading?: boolean
  /** Keeps the content centred above the floating search bar. */
  bottomInset?: number
}

/** Loading, empty, no-match and error states: icon, title, one sentence, at most one action. */
export function AgentHistoryStateView({
  icon: Icon,
  title,
  message,
  action,
  loading = false,
  bottomInset = 0
}: Props) {
  useMobileColorScheme()
  return (
    <View style={[styles.state, { paddingBottom: spacing.xl + bottomInset }]}>
      {loading ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : Icon ? (
        <Icon size={24} color={colors.textMuted} strokeWidth={1.75} />
      ) : null}
      <Text style={loading ? styles.message : styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {action ? (
        <Pressable
          style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
          onPress={action.onPress}
          hitSlop={8}
          accessibilityRole="button"
        >
          <Text style={styles.actionText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: 6
  },
  title: {
    marginTop: spacing.xs,
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center'
  },
  message: {
    maxWidth: 280,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 17,
    textAlign: 'center'
  },
  action: {
    marginTop: spacing.sm,
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  actionPressed: { opacity: 0.7 },
  actionText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  }
}))
