import { StyleSheet } from 'react-native'

import { colors, motion, spacing, radii, typography } from '../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'

export const mobileSessionCommandInputStyles = StyleSheet.create({
  commandDock: {
    zIndex: 20,
    backgroundColor: colors.bgBase,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator
  },
  accessoryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 2
  },
  accessoryScroll: {
    flex: 1,
    minWidth: 0
  },
  accessoryContent: {
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.sm
  },
  // A hairline between the mode chips and the keys they change.
  accessoryDivider: {
    width: StyleSheet.hairlineWidth,
    height: 22,
    backgroundColor: colors.separator
  },
  keyboardDismissSlot: {
    paddingLeft: spacing.md,
    paddingRight: spacing.xs
  },
  keyboardDismissGlyph: {
    alignItems: 'center',
    height: 18,
    justifyContent: 'flex-start',
    position: 'relative',
    width: 18
  },
  keyboardDismissChevron: {
    bottom: -2,
    position: 'absolute'
  },
  inputBar: {
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.md
  },
  // The composer family at reply size: one box holding the field and its round controls.
  inputBox: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingLeft: spacing.xs,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: radii.replyBox,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    backgroundColor: colors.fieldFill
  },
  inputBoxFocused: {
    borderColor: colors.fieldBorderFocused
  },
  inputBoxDisabled: {
    opacity: motion.disabledOpacity
  },
  textInput: {
    flex: 1,
    minWidth: 0,
    height: 32,
    color: colors.textPrimary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 0,
    fontSize: TEXT_INPUT_FONT_SIZE,
    fontFamily: typography.monoFamily
  },
  liveInputFocusTarget: {
    flex: 1,
    minWidth: 0,
    // Reaches over the box's padding so the whole left of the box is the tap target.
    marginVertical: -6,
    marginLeft: -spacing.xs
  },
  liveInputFocusRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.md,
    paddingVertical: spacing.xs,
    borderTopLeftRadius: radii.replyBox,
    borderBottomLeftRadius: radii.replyBox
  },
  liveInputFocusPressed: {
    backgroundColor: colors.fill
  },
  liveInputCapture: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
    color: colors.textPrimary
  }
})
