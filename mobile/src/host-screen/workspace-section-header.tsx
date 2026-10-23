import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET, spacing, textStyles } from '../theme/mobile-theme'
import { pressTransition, slideTransition } from '../components/ui/transition-styles'

/**
 * The list's collapsible group header: `SectionHeader`'s 44 pt disclosure with a leading repo or
 * pin glyph and a project-group indent, which the shared header has no slot for.
 */
export function WorkspaceSectionHeader({
  title,
  count,
  leading,
  expanded,
  pending,
  indent = 0,
  first = false,
  sidebar = false,
  onToggle
}: {
  title: string
  count: number
  leading?: ReactNode
  expanded: boolean
  /** The desktop has not answered this collapse yet. */
  pending: boolean
  indent?: number
  first?: boolean
  sidebar?: boolean
  onToggle: () => void
}) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${count}`}
      accessibilityState={{ expanded }}
      style={({ pressed }) => [
        styles.header,
        first && styles.first,
        { paddingLeft: (sidebar ? spacing.lg : spacing.lg + 4) + indent },
        sidebar && styles.sidebar,
        pressed && styles.pressed,
        pressed ? pressTransition.pressed : pressTransition.rest
      ]}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.count}>{count}</Text>
      {pending ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      <View style={styles.spacer} />
      <View
        style={[expanded ? styles.chevronOpen : styles.chevronClosed, slideTransition]}
        pointerEvents="none"
      >
        <ChevronDown size={16} color={colors.textMuted} strokeWidth={2.2} />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  header: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingRight: spacing.lg + 4,
    paddingTop: spacing.lg
  },
  first: { paddingTop: spacing.xs },
  sidebar: { paddingRight: spacing.lg },
  pressed: { opacity: 0.6 },
  leading: { alignItems: 'center', justifyContent: 'center' },
  title: {
    ...textStyles.footnote,
    fontWeight: '500',
    color: colors.textMuted,
    flexShrink: 1
  },
  count: {
    ...textStyles.footnote,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  spacer: { flex: 1 },
  chevronOpen: { transform: [{ rotate: '0deg' }] },
  chevronClosed: { transform: [{ rotate: '-90deg' }] }
})
