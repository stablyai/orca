import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { LIST_ROW_PADDING } from './ListGroup'

type SectionHeaderProps = {
  title: string
  /** Right-aligned, e.g. "Optional" or a compact action. */
  trailing?: ReactNode
  /** Makes the header a disclosure button whose chevron turns with the state. */
  expanded?: boolean
  onToggle?: () => void
  /** Less space above, for the first section under a header. */
  first?: boolean
}

/** A section's label above a ListGroup: 13 pt in sentence case, lined up with the row text. */
export function SectionHeader({
  title,
  trailing,
  expanded,
  onToggle,
  first = false
}: SectionHeaderProps) {
  useMobileColorScheme()
  const label = (
    <>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.spacer} />
      {typeof trailing === 'string' ? <Text style={styles.title}>{trailing}</Text> : trailing}
    </>
  )
  if (onToggle === undefined) {
    return <View style={[styles.header, first && styles.first]}>{label}</View>
  }
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ expanded: expanded === true }}
      style={({ pressed }) => [
        styles.header,
        styles.toggle,
        first && styles.first,
        pressed && styles.pressed
      ]}
    >
      {label}
      <View style={expanded ? styles.chevronExpanded : styles.chevronCollapsed}>
        <ChevronDown size={15} color={colors.textMuted} strokeWidth={2.2} />
      </View>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingTop: spacing.lg,
    paddingBottom: 6
  },
  toggle: { minHeight: 44, paddingBottom: spacing.xs },
  first: { paddingTop: spacing.xs },
  pressed: { opacity: 0.6 },
  title: { fontSize: 13, fontWeight: '500', color: colors.textSecondary, flexShrink: 1 },
  spacer: { flex: 1 },
  chevronExpanded: { transform: [{ rotate: '0deg' }] },
  chevronCollapsed: { transform: [{ rotate: '-90deg' }] }
}))
