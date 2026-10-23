import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, spacing, textStyles } from '../../theme/mobile-theme'
import { slideTransition } from './transition-styles'

type SectionHeaderProps = {
  title: string
  count?: number
  /** A compact action at the end, e.g. "Stage all". */
  action?: ReactNode
  /** Makes the header a 44 pt disclosure button whose chevron turns with the state. */
  expanded?: boolean
  onToggle?: () => void
  /** Space above; the first header under a nav bar wants less. */
  first?: boolean
  testID?: string
}

/** A list section's label: 13 pt in sentence case, never uppercase. */
export function SectionHeader({
  title,
  count,
  action,
  expanded,
  onToggle,
  first = false,
  testID
}: SectionHeaderProps) {
  const label = (
    <>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {count !== undefined ? <Text style={styles.count}>{count}</Text> : null}
      <View style={styles.spacer} />
      {action}
    </>
  )
  if (onToggle === undefined) {
    return (
      <View style={[styles.header, first && styles.first]} testID={testID}>
        {label}
      </View>
    )
  }
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ expanded: expanded === true }}
      testID={testID}
      style={({ pressed }) => [
        styles.header,
        styles.toggle,
        first && styles.first,
        pressed && styles.pressed
      ]}
    >
      {label}
      <View
        style={[
          expanded === false ? styles.chevronCollapsed : styles.chevronExpanded,
          slideTransition
        ]}
      >
        <ChevronDown size={16} color={colors.textMuted} strokeWidth={2.2} />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg + 4,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm
  },
  toggle: { minHeight: MIN_TOUCH_TARGET, paddingTop: spacing.lg, paddingBottom: 0 },
  first: { paddingTop: spacing.sm },
  pressed: { opacity: 0.6 },
  title: { ...textStyles.footnote, fontWeight: '500', color: colors.textMuted, flexShrink: 1 },
  count: { ...textStyles.footnote, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  spacer: { flex: 1 },
  chevronExpanded: { transform: [{ rotate: '0deg' }] },
  chevronCollapsed: { transform: [{ rotate: '-90deg' }] }
})
