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
  header: {
    marginTop: -spacing.xs
  },
  // Sits in the header's empty leading side, centred on its 52 pt height.
  back: {
    position: 'absolute',
    top: 8,
    left: spacing.xs
  },
  pageTop: {
    height: spacing.sm
  }
}))
