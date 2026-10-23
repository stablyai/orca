import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronRight, ExternalLink } from 'lucide-react-native'
import { Badge, type BadgeTone } from '../components/ui/Badge'
import { pressTransition } from '../components/ui/transition-styles'
import { colors, MIN_TOUCH_TARGET, spacing, textStyles } from '../theme/mobile-theme'
import type { TaskStatusGlyph } from './mobile-tasks-status-glyph'

export type TaskRowBadge = { key: string; label: string; tone: BadgeTone }

type Props = {
  title: string
  /** The one secondary line: repo · #number · age. */
  meta: string
  /** A repo or team colour, drawn as a small dot before the secondary line. */
  metaDotColor?: string
  status?: TaskStatusGlyph | null
  /** Makes the status glyph its own 44 pt button, e.g. Linear's change status. */
  onStatusPress?: () => void
  statusDisabled?: boolean
  badges?: readonly TaskRowBadge[]
  onPress: () => void
  /** The row opens the browser instead of a sheet. */
  opensExternally?: boolean
  numberOfTitleLines?: number
  numberOfMetaLines?: number
  children?: ReactNode
}

/** A plain-list task row: a 16 pt title, one grey line, a status glyph and a chevron. */
export function MobileTaskRow({
  title,
  meta,
  metaDotColor,
  status,
  onStatusPress,
  statusDisabled = false,
  badges,
  onPress,
  opensExternally = false,
  numberOfTitleLines = 2,
  numberOfMetaLines = 1,
  children
}: Props) {
  const glyph = status ? <status.icon size={18} color={status.color} strokeWidth={2.2} /> : null
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={opensExternally ? 'link' : 'button'}
      accessibilityLabel={status ? `${title}, ${status.label}` : title}
      accessibilityHint={opensExternally ? 'Opens in the browser' : undefined}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.row,
            pressed && styles.pressed,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <View style={styles.main}>
            <Text style={styles.title} numberOfLines={numberOfTitleLines}>
              {title}
            </Text>
            {meta ? (
              <View style={styles.metaRow}>
                {metaDotColor ? (
                  <View style={[styles.metaDot, { backgroundColor: metaDotColor }]} />
                ) : null}
                <Text style={styles.meta} numberOfLines={numberOfMetaLines}>
                  {meta}
                </Text>
              </View>
            ) : null}
            {badges && badges.length > 0 ? (
              <View style={styles.badges}>
                {badges.map((badge) => (
                  <Badge key={badge.key} label={badge.label} tone={badge.tone} />
                ))}
              </View>
            ) : null}
            {children}
          </View>
          {glyph && onStatusPress ? (
            <Pressable
              onPress={(event) => {
                event.stopPropagation()
                onStatusPress()
              }}
              disabled={statusDisabled}
              accessibilityRole="button"
              accessibilityLabel={`Change status from ${status?.label ?? ''}`}
              style={[styles.statusButton, statusDisabled && styles.disabled]}
            >
              {({ pressed: statusPressed }) => (
                <View
                  style={[
                    styles.statusCircle,
                    statusPressed && styles.statusPressed,
                    statusPressed ? pressTransition.pressed : pressTransition.rest
                  ]}
                >
                  {glyph}
                </View>
              )}
            </Pressable>
          ) : glyph ? (
            <View style={styles.statusSlot}>{glyph}</View>
          ) : null}
          {opensExternally ? (
            <ExternalLink size={15} color={colors.textMuted} strokeWidth={2.2} />
          ) : (
            <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
          )}
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
    paddingVertical: spacing.md
  },
  pressed: { backgroundColor: colors.fill },
  main: { flex: 1, minWidth: 0, gap: 3 },
  title: { ...textStyles.body, fontWeight: '500', color: colors.textPrimary },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  metaDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  meta: {
    ...textStyles.subhead,
    flex: 1,
    minWidth: 0,
    color: colors.textSecondary
  },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  statusSlot: { width: 24, alignItems: 'center', flexShrink: 0 },
  // The 44 pt box overhangs the row's gap so the glyph still lines up with plain rows.
  statusButton: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    marginHorizontal: -10,
    alignItems: 'center',
    justifyContent: 'center'
  },
  statusCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center'
  },
  statusPressed: { backgroundColor: colors.fillPressed },
  disabled: { opacity: 0.4 }
})
