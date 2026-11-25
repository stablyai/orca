import { spacing } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'

export const sessionOptionPickerStyles = themedStyleSheet(() => ({
  // The action row's only shrinkable item: a long label truncates before it pushes Send off.
  pillSlot: {
    flexShrink: 1,
    minWidth: 0
  },
  sheet: {
    paddingBottom: spacing.xs
  },
  sheetFill: {
    flex: 1,
    minHeight: 0
  },
  header: {
    marginTop: -spacing.xs
  },
  pageTop: {
    height: spacing.sm
  }
}))
