import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { Check, ChevronDown, ChevronRight } from 'lucide-react-native'
import { DisclosureChevron } from '../DisclosureChevron'
import { triggerSelection } from '../../platform/haptics'
import { colors, feedback, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export const LIST_ROW_PADDING = spacing.lg
export const LIST_LEADING_SLOT = 24
/** Where hairlines start in a group whose rows carry a leading icon, so they line up with the text. */
export const LIST_LEADING_INSET = LIST_ROW_PADDING + LIST_LEADING_SLOT + spacing.md

type ListGroupProps = {
  children: ReactNode
  separatorInset?: number
  style?: StyleProp<ViewStyle>
}

/** Rows on one rounded surface with hairlines between them; the group draws the separators, never the rows. */
export function ListGroup({ children, separatorInset = LIST_ROW_PADDING, style }: ListGroupProps) {
  useMobileColorScheme()
  const rows = Children.toArray(children).filter(isValidElement)
  return (
    <View style={[styles.group, style]}>
      {rows.map((row, index) => (
        <Fragment key={String(row.key)}>
          {index > 0 ? <View style={[styles.separator, { marginLeft: separatorInset }]} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  group: {
    borderRadius: radii.surface,
    backgroundColor: colors.sheetGroup,
    overflow: 'hidden'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle
  }
}))

// Kept beside ListGroup: as its own module it costs the page bundle a shared chunk under the asset ceiling.
type SectionHeaderProps = {
  title: string
  /** A small mark before the title, e.g. the agent a section belongs to. */
  icon?: ReactNode
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
  icon,
  trailing,
  expanded,
  onToggle,
  first = false
}: SectionHeaderProps) {
  useMobileColorScheme()
  const label = (
    <>
      {icon}
      <Text style={sectionHeaderStyles.title} numberOfLines={1}>
        {title}
      </Text>
      <View style={sectionHeaderStyles.spacer} />
      {typeof trailing === 'string' ? (
        <Text style={sectionHeaderStyles.title}>{trailing}</Text>
      ) : (
        trailing
      )}
    </>
  )
  if (onToggle === undefined) {
    return (
      <View style={[sectionHeaderStyles.header, first && sectionHeaderStyles.first]}>{label}</View>
    )
  }
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ expanded: expanded === true }}
      style={({ pressed }) => [
        sectionHeaderStyles.header,
        sectionHeaderStyles.toggle,
        first && sectionHeaderStyles.first,
        pressed && sectionHeaderStyles.pressed
      ]}
    >
      {label}
      <DisclosureChevron expanded={expanded === true} collapsedDeg={-90} expandedDeg={0}>
        <ChevronDown size={15} color={colors.textMuted} strokeWidth={2.2} />
      </DisclosureChevron>
    </Pressable>
  )
}

const sectionHeaderStyles = themedStyleSheet(() => ({
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
  spacer: { flex: 1 }
}))

// Kept beside ListGroup for the same reason as SectionHeader: one module, one page chunk.
type ListRowProps = {
  title: string
  subtitle?: string
  /** Richer content under the title, e.g. usage bars or a coloured status line. */
  detail?: ReactNode
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
  onLongPress?: () => void
  disabled?: boolean
  /** Working on a press: stops taking taps without the disabled dimming. */
  busy?: boolean
  accessibilityLabel?: string
  accessibilityRole?: 'button' | 'link' | 'radio' | 'checkbox' | 'switch'
  testID?: string
}

/** One row of a grouped list: 48 pt, or 60 with a subtitle, with a trailing value, chevron or check. */
export function ListRow({
  title,
  subtitle,
  detail,
  leading,
  value,
  accessory,
  navigates = false,
  selected,
  destructive = false,
  onPress,
  onLongPress,
  disabled = false,
  busy = false,
  accessibilityLabel,
  accessibilityRole,
  testID
}: ListRowProps) {
  useMobileColorScheme()
  const inertState = { disabled: disabled || busy, ...(busy && { busy }) }
  const rowStyle = [
    listRowStyles.row,
    subtitle !== undefined && listRowStyles.rowTwoLine,
    disabled && listRowStyles.disabled
  ]
  const content = (
    <>
      {leading !== undefined ? <View style={listRowStyles.leading}>{leading}</View> : null}
      <View style={listRowStyles.main}>
        <Text
          style={[
            listRowStyles.title,
            subtitle !== undefined && listRowStyles.titleEmphasis,
            destructive && listRowStyles.titleDestructive
          ]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle !== undefined ? (
          <Text style={listRowStyles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
        {detail}
      </View>
      {value !== undefined ? (
        <Text style={listRowStyles.value} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {accessory}
      {selected ? <Check size={17} color={colors.textPrimary} strokeWidth={2.4} /> : null}
      {selected === false ? <View style={listRowStyles.checkSpace} /> : null}
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
      onPress={() => {
        // Picking a new option ticks; re-tapping the picked one or opening a screen doesn't.
        if (selected === false) {
          triggerSelection()
        }
        onPress()
      }}
      onLongPress={onLongPress}
      delayLongPress={onLongPress ? 400 : undefined}
      disabled={inertState.disabled}
      accessibilityRole={accessibilityRole ?? (selected === undefined ? 'button' : 'radio')}
      accessibilityLabel={accessibilityLabel ?? (value ? `${title}, ${value}` : title)}
      accessibilityState={
        selected === undefined ? inertState : { ...inertState, checked: selected, selected }
      }
      testID={testID}
      style={({ pressed }) => [...rowStyle, pressed && listRowStyles.pressed]}
    >
      {content}
    </Pressable>
  )
}

const listRowStyles = themedStyleSheet(() => ({
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
  pressed: { backgroundColor: colors.translucentFill },
  disabled: { opacity: feedback.disabledOpacity },
  leading: { width: LIST_LEADING_SLOT, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 15, color: colors.textPrimary },
  titleEmphasis: { fontWeight: '500' },
  titleDestructive: { color: colors.statusRed },
  subtitle: { fontSize: 13, color: colors.textSecondary },
  value: { fontSize: 15, color: colors.textSecondary, flexShrink: 1, maxWidth: 180 },
  checkSpace: { width: 17 }
}))
