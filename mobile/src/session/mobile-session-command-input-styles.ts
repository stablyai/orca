import { StyleSheet } from 'react-native'

import { colors, spacing, radii, typography } from '../theme/mobile-theme'

/** Command dock styles. The field grows with the draft and stops at 120px. */
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
    zIndex: 20,
    backgroundColor: colors.bgPanel
  },
  accessoryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  accessoryRowsContainer: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 2,
    gap: 2
  },
  accessoryCollapseStrip: {
    height: 14,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  accessoryRow: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  accessoryScroll: {
    flex: 1,
    minWidth: 0
  },
  accessoryContent: {
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    gap: spacing.xs
  },
  accessoryKey: {
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 2,
    borderRadius: radii.button,
    minWidth: 36,
    minHeight: 26,
    justifyContent: 'center',
    alignItems: 'center'
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
  // Same box as accessoryKey, named apart so these icons can change without resizing every shortcut.
  accessoryActionsCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginRight: spacing.sm
  },
  accessoryActionButton: {
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 2,
    borderRadius: radii.button,
    minWidth: 36,
    minHeight: 26,
    justifyContent: 'center',
    alignItems: 'center'
  },
  accessoryActionButtonActive: {
    backgroundColor: colors.textPrimary
  },
  keyboardDismissKey: {
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    marginLeft: spacing.sm,
    marginVertical: 1,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 0,
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
    alignItems: 'flex-end',
    gap: 2,
    minHeight: 44,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  textInput: {
    flex: 1,
    minHeight: 34,
    maxHeight: 120,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingLeft: 6,
    paddingRight: 6,
    paddingTop: spacing.xs + 1,
    paddingBottom: spacing.xs + 1,
    fontSize: 14,
    fontFamily: typography.monoFamily,
    lineHeight: 20,
    includeFontPadding: false
  },
  liveInputBar: {
    gap: 2
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

  liveInputCapture: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
    color: colors.textPrimary
  },
  sendButton: {
    backgroundColor: colors.bgRaised,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dictationButton: {
    backgroundColor: colors.bgRaised,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center'
  },
  dictationButtonActive: {
    backgroundColor: colors.bgPanel,
    borderColor: colors.textSecondary
  },
  sendButtonDisabled: {
    opacity: 0.35
  }
})
