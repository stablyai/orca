import { StyleSheet, Text, View } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import { colors, radii, textStyles } from '../../theme/mobile-theme'

export type BadgeTone = 'neutral' | 'green' | 'amber' | 'red' | 'purple' | 'blue'

const TONE: Record<BadgeTone, { text: string; fill: string }> = {
  neutral: { text: colors.textSecondary, fill: colors.fill },
  green: { text: colors.statusGreen, fill: 'rgba(34, 197, 94, 0.12)' },
  amber: { text: colors.statusAmber, fill: 'rgba(245, 158, 11, 0.12)' },
  red: { text: colors.danger, fill: 'rgba(255, 107, 107, 0.12)' },
  purple: { text: colors.statusPurple, fill: 'rgba(167, 139, 250, 0.12)' },
  blue: { text: '#7aa7f8', fill: 'rgba(59, 130, 246, 0.14)' }
}

type BadgeProps = { label: string; tone?: BadgeTone; icon?: LucideIcon; testID?: string }

/** A quiet 22 pt capsule for state and counts; never tappable. */
export function Badge({ label, tone = 'neutral', icon: Icon, testID }: BadgeProps) {
  const { text, fill } = TONE[tone]
  return (
    <View
      style={[styles.badge, Icon && styles.withIcon, { backgroundColor: fill }]}
      testID={testID}
    >
      {Icon ? <Icon size={12} color={text} strokeWidth={2.4} /> : null}
      <Text style={[styles.label, { color: text }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    height: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    borderRadius: radii.pill,
    alignSelf: 'center',
    flexShrink: 0
  },
  withIcon: { paddingLeft: 6 },
  label: { ...textStyles.caption, fontWeight: '500', fontVariant: ['tabular-nums'] }
})
