import type { ReactElement } from 'react'
import { FlatList, Pressable, Text } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { colors, spacing, pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// About two banners tall: the workspace below stays reachable however many notices wait.
const OLDER_NOTICES_MAX_HEIGHT = 176

/** "<N> more prompts not sent" under the newest notice; tapping shows or hides the older ones. */
export function MoreGeneratedInputNoticesRow({
  label,
  expanded,
  onToggle
}: {
  label: string
  expanded: boolean
  onToggle: () => void
}) {
  useMobileColorScheme()
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      style={({ pressed }) => [styles.row, pressed && pressedStyle]}
    >
      <Chevron size={14} color={colors.textMuted} />
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  )
}

/** The older notices, newest first, in a bounded scrolling area that mounts only a window of them. */
export function OlderGeneratedInputNotices<T>({
  items,
  keyOf,
  render
}: {
  items: readonly T[]
  keyOf: (item: T) => string
  render: (item: T) => ReactElement
}) {
  return (
    <FlatList
      data={items}
      keyExtractor={keyOf}
      renderItem={({ item }) => render(item)}
      style={styles.list}
      nestedScrollEnabled
      initialNumToRender={4}
      windowSize={3}
    />
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  label: { flex: 1, color: colors.textMuted, fontSize: 13 },
  list: { maxHeight: OLDER_NOTICES_MAX_HEIGHT, flexGrow: 0 }
}))
