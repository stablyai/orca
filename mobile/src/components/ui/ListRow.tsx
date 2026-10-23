import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Check, ChevronRight } from 'lucide-react-native'
import { colors, motion, spacing, textStyles } from '../../theme/mobile-theme'
import { LIST_ROW_PADDING } from './ListGroup'

type ListRowProps = {
  title: string
  subtitle?: string
  /** Colours the subtitle, e.g. amber for "Waiting for your permission". */
  subtitleColor?: string
  /** Red title, for an action row that loses work. */
  destructive?: boolean
  /** A 28 pt slot for an icon or a status dot. */
  leading?: ReactNode
  /** A trailing value in grey, e.g. "Ask first". */
  value?: string
  /** Anything after the value: a badge, a switch, a spinner. */
  accessory?: ReactNode
  /** Draws a chevron: the row opens another screen. */
  navigates?: boolean
  /** Draws a check: the row is the picked option. */
  selected?: boolean
  onPress?: () => void
  onLongPress?: () => void
  disabled?: boolean
  accessibilityLabel?: string
  accessibilityRole?: 'button' | 'radio' | 'switch' | 'link'
  testID?: string
  titleNumberOfLines?: number
  subtitleNumberOfLines?: number
}

/** One row of a list: 52 pt with one line, 64 with two, pressed fill, trailing chevron or check. */
export function ListRow({
  title,
  subtitle,
  subtitleColor,
  destructive = false,
  leading,
  value,
  accessory,
  navigates = false,
  selected,
  onPress,
  onLongPress,
  disabled = false,
  accessibilityLabel,
  accessibilityRole,
  testID,
  titleNumberOfLines = 1,
  subtitleNumberOfLines = 1
}: ListRowProps) {
  const interactive = onPress !== undefined || onLongPress !== undefined
  const role = accessibilityRole ?? (selected === undefined ? 'button' : 'radio')
  const content = (pressed: boolean) => (
    <View
      style={[
        styles.row,
        subtitle !== undefined && styles.rowTwoLine,
        pressed && styles.pressed,
        disabled && styles.disabled
      ]}
    >
      {leading !== undefined ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.main}>
        <Text
          style={[
            styles.title,
            subtitle !== undefined && styles.titleEmphasis,
            destructive && styles.titleDestructive
          ]}
          numberOfLines={titleNumberOfLines}
        >
          {title}
        </Text>
        {subtitle !== undefined ? (
          <Text
            style={[styles.subtitle, subtitleColor !== undefined && { color: subtitleColor }]}
            numberOfLines={subtitleNumberOfLines}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value !== undefined ? (
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {accessory}
      {selected ? <Check size={18} color={colors.textPrimary} strokeWidth={2.4} /> : null}
      {selected === false ? <View style={styles.checkSpace} /> : null}
      {navigates ? <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} /> : null}
    </View>
  )
  if (!interactive) {
    return <View testID={testID}>{content(false)}</View>
  }
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={
        selected === undefined ? { disabled } : { disabled, checked: selected, selected }
      }
      testID={testID}
    >
      {({ pressed }) => content(pressed)}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: 10
  },
  rowTwoLine: { minHeight: 66 },
  pressed: { backgroundColor: colors.fill },
  disabled: { opacity: motion.disabledOpacity },
  leading: { width: 28, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...textStyles.body, color: colors.textPrimary },
  titleEmphasis: { fontSize: 17, lineHeight: 22, fontWeight: '500' },
  titleDestructive: { color: colors.danger },
  subtitle: { ...textStyles.callout, color: colors.textSecondary },
  value: { ...textStyles.callout, color: colors.textSecondary, flexShrink: 1, maxWidth: 180 },
  checkSpace: { width: 18 }
})
