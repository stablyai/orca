import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  useContext,
  type ReactNode
} from 'react'
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { Check, ChevronDown, ChevronRight } from '../icons/app-icons'
import { DisclosureChevron } from './DisclosureChevron'
import { listStyleMetrics as metrics } from './list-style-metrics'
import { triggerSelection } from '../../platform/haptics/haptics'
import { colors, feedback, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

export const LIST_ROW_PADDING = metrics.rowPadding
export const LIST_LEADING_SLOT = metrics.leadingSlot
/** Where hairlines start in a group whose rows carry a leading icon, so they line up with the text. */
export const LIST_LEADING_INSET = LIST_ROW_PADDING + LIST_LEADING_SLOT + metrics.rowGap

const GroupedScreenContext = createContext(false)

/** Marks a screen of grouped lists (on colors.groupedBackground), whose groups take the screen's fill, not a sheet's. */
export function GroupedListScreen({ children }: { children: ReactNode }) {
  return <GroupedScreenContext.Provider value>{children}</GroupedScreenContext.Provider>
}

type ListGroupProps = {
  children: ReactNode
  separatorInset?: number
  style?: StyleProp<ViewStyle>
}

/** Rows on one rounded surface, with hairlines between them where the platform draws them; never the rows. */
export function ListGroup({ children, separatorInset = LIST_ROW_PADDING, style }: ListGroupProps) {
  useMobileColorScheme()
  const onGroupedScreen = useContext(GroupedScreenContext)
  const rows = Children.toArray(children).filter(isValidElement)
  return (
    <View style={[styles.group, onGroupedScreen && styles.groupOnScreen, style]}>
      {rows.map((row, index) => (
        <Fragment key={String(row.key)}>
          {index > 0 && metrics.separators ? (
            <View style={[styles.separator, { marginLeft: separatorInset }]} />
          ) : null}
          {row}
        </Fragment>
      ))}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  group: {
    borderRadius: metrics.groupRadius,
    backgroundColor: colors.sheetGroup,
    overflow: 'hidden'
  },
  groupOnScreen: { backgroundColor: colors.groupedSurface },
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

/** A section's label above a ListGroup, in sentence case and lined up with the row text. */
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
      android_ripple={metrics.ripple ? { color: colors.translucentFill } : undefined}
      style={({ pressed }) => [
        sectionHeaderStyles.header,
        sectionHeaderStyles.toggle,
        first && sectionHeaderStyles.first,
        pressed && !metrics.ripple && sectionHeaderStyles.pressed
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
    paddingTop: metrics.headerPaddingTop,
    paddingBottom: metrics.headerPaddingBottom
  },
  toggle: { minHeight: 44, paddingBottom: spacing.xs },
  first: { paddingTop: spacing.xs },
  pressed: { opacity: 0.6 },
  title: { ...metrics.header, color: colors[metrics.headerColor], flexShrink: 1 },
  spacer: { flex: 1 }
}))

// Kept beside ListGroup for the same reason as SectionHeader: one module, one page chunk.
type ListRowProps = {
  title: string
  /** The title is a sentence (a fact, a message) and wraps rather than cutting off. */
  wrapTitle?: boolean
  subtitle?: string
  /** The subtitle is code, e.g. a command, and is set in the monospace face. */
  subtitleMono?: boolean
  /** A subtitle that is a status to act on, e.g. "Needs sign-in", in its tone's colour. */
  subtitleColor?: string
  /** A muted mark in a fixed-width column before the title, e.g. an item's `#35`. */
  marker?: string
  /** Lines the subtitle may take before it cuts; two by default. */
  subtitleLines?: number
  /** Richer content under the title, e.g. usage bars or a coloured status line. */
  detail?: ReactNode
  /** A slot for an icon or a status dot, 24 pt wide or as wide as its content. */
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
  /** Something new to read: the title bolder. */
  strong?: boolean
  onPress?: () => void
  onLongPress?: () => void
  disabled?: boolean
  /** Working on a press: stops taking taps without the disabled dimming. */
  busy?: boolean
  accessibilityLabel?: string
  accessibilityRole?: 'button' | 'link' | 'radio' | 'checkbox' | 'switch'
  testID?: string
}

/** One row of a grouped list, taller with a subtitle, with a trailing value, chevron or check. */
export function ListRow({
  title,
  wrapTitle = false,
  subtitle,
  subtitleMono = false,
  subtitleColor,
  marker,
  subtitleLines = 2,
  detail,
  leading,
  value,
  accessory,
  navigates = false,
  selected,
  destructive = false,
  strong = false,
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
  const main = (
    <View style={listRowStyles.main}>
      <Text
        style={[
          listRowStyles.title,
          subtitle !== undefined && listRowStyles.titleEmphasis,
          strong && listRowStyles.titleStrong,
          destructive && listRowStyles.titleDestructive
        ]}
        numberOfLines={wrapTitle ? undefined : 1}
      >
        {title}
      </Text>
      {subtitle !== undefined ? (
        <Text
          style={[
            listRowStyles.subtitle,
            subtitleMono && listRowStyles.subtitleMono,
            subtitleColor !== undefined && { color: subtitleColor }
          ]}
          numberOfLines={subtitleLines}
        >
          {subtitle}
        </Text>
      ) : null}
      {detail}
    </View>
  )
  const content = (
    <>
      {leading !== undefined ? <View style={listRowStyles.leading}>{leading}</View> : null}
      {marker !== undefined ? (
        <View style={listRowStyles.marked}>
          <Text style={[listRowStyles.title, listRowStyles.marker]} numberOfLines={1}>
            {marker}
          </Text>
          {main}
        </View>
      ) : (
        main
      )}
      {value !== undefined ? (
        <Text style={listRowStyles.value} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {accessory}
      {selected ? <Check size={17} color={colors.textPrimary} strokeWidth={2.4} /> : null}
      {selected === false ? <View style={listRowStyles.checkSpace} /> : null}
      {navigates ? (
        <ChevronRight size={15} color={colors.disclosureTint} strokeWidth={2.2} />
      ) : null}
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
      android_ripple={metrics.ripple ? { color: colors.translucentFill } : undefined}
      style={({ pressed }) => [...rowStyle, pressed && !metrics.ripple && listRowStyles.pressed]}
    >
      {content}
    </Pressable>
  )
}

const listRowStyles = themedStyleSheet(() => ({
  row: {
    minHeight: metrics.rowMinHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: metrics.rowGap,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: metrics.rowPaddingVertical
  },
  rowTwoLine: { minHeight: metrics.rowTwoLineMinHeight },
  // A translucent wash: bgRaised matches sheetGroup in dark, so it would not show.
  pressed: { backgroundColor: colors.translucentFill },
  disabled: { opacity: feedback.disabledOpacity },
  leading: { minWidth: LIST_LEADING_SLOT, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, minWidth: 0, gap: 2 },
  marked: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start' },
  marker: {
    minWidth: 48,
    paddingRight: spacing.sm,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  },
  title: { ...metrics.title, color: colors.textPrimary },
  titleEmphasis: { fontWeight: metrics.titleWithSubtitleWeight },
  titleStrong: { fontWeight: '700' },
  titleDestructive: { color: colors.statusRed },
  subtitle: { ...metrics.subtitle, color: colors.textSecondary },
  subtitleMono: { fontFamily: typography.monoFamily },
  value: { ...metrics.value, color: colors.textSecondary, flexShrink: 1, maxWidth: 180 },
  checkSpace: { width: 17 }
}))
