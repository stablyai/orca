import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { ChevronDown } from 'lucide-react-native'
import { DisclosureChevron } from '../DisclosureChevron'
import { colors, radii, spacing } from '../../theme/mobile-theme'
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
