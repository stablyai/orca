import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Check, ChevronRight } from 'lucide-react-native'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { LIST_LEADING_SLOT, LIST_ROW_PADDING } from './ListGroup'

type ListRowProps = {
  title: string
  subtitle?: string
  /** A slot for an icon or a status dot. */
  leading?: ReactNode
  /** The current value in grey, e.g. "This computer". */
  value?: string
  /** Anything after the value: a switch, a badge, a spinner. */
  accessory?: ReactNode
  /** Draws a chevron: the row opens a picker or another screen. */
  navigates?: boolean
  /** Draws a check: the row is the picked option. */
  selected?: boolean
  destructive?: boolean
  onPress?: () => void
  disabled?: boolean
  accessibilityLabel?: string
  accessibilityRole?: 'button' | 'radio' | 'checkbox' | 'switch'
  testID?: string
}

/** One row of a grouped list: 48 pt, or 60 with a subtitle, with a trailing value, chevron or check. */
export function ListRow({
  title,
  subtitle,
  leading,
  value,
  accessory,
  navigates = false,
  selected,
  destructive = false,
  onPress,
  disabled = false,
  accessibilityLabel,
  accessibilityRole,
  testID
}: ListRowProps) {
  useMobileColorScheme()
  const rowStyle = [
    styles.row,
    subtitle !== undefined && styles.rowTwoLine,
    disabled && styles.disabled
  ]
  const content = (
    <>
      {leading !== undefined ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.main}>
        <Text
          style={[
            styles.title,
            subtitle !== undefined && styles.titleEmphasis,
            destructive && styles.titleDestructive
          ]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle !== undefined ? (
          <Text style={styles.subtitle} numberOfLines={2}>
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
      {selected ? <Check size={17} color={colors.textPrimary} strokeWidth={2.4} /> : null}
      {selected === false ? <View style={styles.checkSpace} /> : null}
      {navigates ? <ChevronRight size={15} color={colors.textMuted} strokeWidth={2.2} /> : null}
    </>
  )
  if (onPress === undefined) {
    return (
      <View style={rowStyle} testID={testID}>
        {content}
      </View>
    )
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={accessibilityRole ?? (selected === undefined ? 'button' : 'radio')}
      accessibilityLabel={accessibilityLabel ?? (value ? `${title}, ${value}` : title)}
      accessibilityState={
        selected === undefined ? { disabled } : { disabled, checked: selected, selected }
      }
      testID={testID}
      style={({ pressed }) => [...rowStyle, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.sm
  },
  rowTwoLine: { minHeight: 60 },
  // A translucent wash: bgRaised matches sheetGroup in dark, so it would not show.
  pressed: { backgroundColor: colors.borderSubtle },
  disabled: { opacity: 0.4 },
  leading: { width: LIST_LEADING_SLOT, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 15, color: colors.textPrimary },
  titleEmphasis: { fontWeight: '500' },
  titleDestructive: { color: colors.statusRed },
  subtitle: { fontSize: 13, color: colors.textSecondary },
  value: { fontSize: 15, color: colors.textSecondary, flexShrink: 1, maxWidth: 180 },
  checkSpace: { width: 17 }
}))
