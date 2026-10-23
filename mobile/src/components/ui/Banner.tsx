import { StyleSheet, Text, View } from 'react-native'
import { AlertCircle, AlertTriangle, Info, X } from 'lucide-react-native'
import { colors, radii, spacing, textStyles } from '../../theme/mobile-theme'
import { Button } from './Button'
import { IconButton } from './IconButton'

type BannerTone = 'info' | 'warning' | 'error'

type BannerAction = { label: string; onPress: () => void; busy?: boolean; destructive?: boolean }

type BannerProps = {
  tone?: BannerTone
  title?: string
  message: string
  action?: BannerAction
  /** Several actions in a row; the first reads as the main one. */
  actions?: readonly BannerAction[]
  onDismiss?: () => void
  dismissLabel?: string
  testID?: string
}

const TONE = {
  info: { icon: Info, color: colors.textSecondary, fill: colors.fill },
  warning: { icon: AlertTriangle, color: colors.statusAmber, fill: colors.warningFill },
  error: { icon: AlertCircle, color: colors.danger, fill: colors.errorFill }
} as const

/** The one inline notice: status icon, 15 pt text, one compact action, optional dismiss. */
export function Banner({
  tone = 'info',
  title,
  message,
  action,
  actions,
  onDismiss,
  dismissLabel = 'Dismiss',
  testID
}: BannerProps) {
  const { icon: Icon, color, fill } = TONE[tone]
  const allActions = actions ?? (action ? [action] : [])
  return (
    <View
      style={[styles.banner, { backgroundColor: fill }]}
      accessibilityRole={tone === 'info' ? undefined : 'alert'}
      testID={testID}
    >
      <Icon size={18} color={color} strokeWidth={2.2} style={styles.icon} />
      <View style={styles.main}>
        {title !== undefined ? <Text style={styles.title}>{title}</Text> : null}
        <Text style={styles.message}>{message}</Text>
        {allActions.length > 0 ? (
          <View style={styles.actions}>
            {allActions.map((item) => (
              <Button
                key={item.label}
                label={item.label}
                onPress={item.onPress}
                busy={item.busy}
                variant={item.destructive ? 'destructive' : 'secondary'}
                size="compact"
              />
            ))}
          </View>
        ) : null}
      </View>
      {onDismiss ? (
        <IconButton
          icon={X}
          accessibilityLabel={dismissLabel}
          onPress={onDismiss}
          variant="bare"
          iconSize={16}
          iconColor={colors.textMuted}
          style={styles.dismiss}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    borderRadius: radii.group
  },
  icon: { marginTop: 1 },
  main: { flex: 1, minWidth: 0, gap: 2, paddingRight: spacing.sm },
  title: { ...textStyles.callout, fontWeight: '600', color: colors.textPrimary },
  message: { ...textStyles.callout, color: colors.textSecondary },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  dismiss: { marginTop: -10 }
})
