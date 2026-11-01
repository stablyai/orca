import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
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
