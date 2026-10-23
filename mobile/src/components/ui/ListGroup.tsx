import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { colors, radii, spacing } from '../../theme/mobile-theme'

type ListGroupProps = {
  children: ReactNode
  /** Where hairlines start, so they line up with the row text rather than the group edge. */
  separatorInset?: number
  /** `inset` is a rounded group on the canvas; `plain` is full width, for long lists. */
  appearance?: 'inset' | 'plain'
  style?: StyleProp<ViewStyle>
}

export const LIST_ROW_PADDING = spacing.lg
/** The leading slot plus its gap, for groups whose rows carry an icon or a status dot. */
export const LIST_LEADING_INSET = spacing.lg + 28 + spacing.md

/** Rows with hairlines between them; the group draws the separators, so rows never do. */
export function ListGroup({
  children,
  separatorInset = LIST_ROW_PADDING,
  appearance = 'inset',
  style
}: ListGroupProps) {
  const rows = Children.toArray(children).filter(isValidElement)
  return (
    <View style={[appearance === 'inset' ? styles.inset : styles.plain, style]}>
      {rows.map((row, index) => (
        // Children.toArray gives every row a key.
        <Fragment key={String(row.key)}>
          {index > 0 ? <View style={[styles.separator, { marginLeft: separatorInset }]} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  inset: {
    marginHorizontal: spacing.lg,
    borderRadius: radii.group,
    backgroundColor: colors.groupFill,
    overflow: 'hidden'
  },
  plain: {},
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator
  }
})
