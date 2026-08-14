import { StyleSheet } from 'react-native'

import { colors, spacing, radii, typography } from '../theme/mobile-theme'

// Accessory-key grid geometry, shared with useMobileKeypadHeight so the
// resize snap lands exactly on whole rows. Keys are a fixed height (instead of
// padding-derived) so every row is the same pixel stride regardless of which
// keys are rendered.
export const ACCESSORY_KEY_HEIGHT = 30
export const ACCESSORY_ROW_GAP = spacing.xs
export const ACCESSORY_GRID_VERTICAL_PADDING = spacing.xs * 2

export const mobileSessionCommandInputStyles = StyleSheet.create({
  createWarningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  createWarningText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 12,
    lineHeight: 16
  },
  createWarningDismiss: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -4
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    marginBottom: spacing.lg
  },
  createError: {
    color: colors.statusRed,
    fontSize: 13,
    marginBottom: spacing.sm
  },
  emptyActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm
  },
  createButton: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button
  },
  createButtonDisabled: {
    opacity: 0.5
  },
  createButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  commandDock: {
    zIndex: 20
  },
  keypadResizeHandle: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 12,
    backgroundColor: colors.bgPanel
  },
  keypadResizeHandleActive: {
    backgroundColor: colors.borderSubtle
  },
  keypadResizeHandleGrip: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textMuted,
    opacity: 0.5
  },
  accessoryBar: {
    // Why row: the scroll view's flex:1 must grow horizontally; in a column its
    // flexBasis:0 would override the explicit height and collapse the grid.
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  accessoryKeysScroll: {
    flex: 1,
    minWidth: 0
  },
  accessoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: ACCESSORY_ROW_GAP,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  accessoryKey: {
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm + 2,
    height: ACCESSORY_KEY_HEIGHT,
    borderRadius: radii.button,
    minWidth: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  accessoryKeyPressed: {
    backgroundColor: colors.borderSubtle
  },
  accessoryKeyActive: {
    backgroundColor: colors.textPrimary
  },
  customAccessoryKey: {
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  accessoryKeyDisabled: {
    opacity: 0.35
  },
  accessoryKeyText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: typography.monoFamily
  },
  accessoryKeyTextActive: {
    color: colors.bgBase,
    fontWeight: '700'
  },
  accessoryKeyTextDisabled: {
    color: colors.textMuted
  },
  keyboardDismissKey: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm + 2,
    height: ACCESSORY_KEY_HEIGHT,
    borderRadius: radii.button,
    minWidth: 36
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
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 46,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  textInput: {
    flex: 1,
    height: 34,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: 0,
    fontSize: 14,
    fontFamily: typography.monoFamily,
    marginRight: spacing.sm
  },
  liveInputBar: {
    gap: spacing.sm
  },

  liveInputFocusTarget: {
    flex: 1,
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    paddingHorizontal: spacing.sm + 2
  },
  liveInputFocusTargetPressed: {
    backgroundColor: colors.borderSubtle
  },
  liveInputFocusTargetDisabled: {
    opacity: 0.45
  },

  keypadToggleButton: {
    backgroundColor: colors.bgRaised,
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center'
  },
  keypadTogglePressed: {
    backgroundColor: colors.borderSubtle
  },

  liveInputCapture: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
    color: colors.textPrimary
  },
  sendButton: {
    backgroundColor: colors.bgRaised,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dictationButton: {
    backgroundColor: colors.bgRaised,
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  dictationButtonActive: {
    backgroundColor: colors.bgPanel,
    borderColor: colors.textSecondary
  },
  sendButtonDisabled: {
    opacity: 0.35
  }
})
