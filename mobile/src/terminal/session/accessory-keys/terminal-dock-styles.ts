import { StyleSheet } from 'react-native'
import { colors, feedback, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'

const KEY_HEIGHT = 32
const KEY_ROW_HEIGHT = 46
const KEY_GAP = spacing.sm
const KEY_RADIUS = radii.control
// The smart group wraps its keys with this much room on each side, inside the same row.
const SMART_GROUP_INSET = spacing.xs

/** Grows each 32 pt key to the row's height and halfway into its neighbours' gaps. */
export const TERMINAL_KEY_HIT_SLOP = {
  top: (KEY_ROW_HEIGHT - KEY_HEIGHT) / 2,
  bottom: (KEY_ROW_HEIGHT - KEY_HEIGHT) / 2,
  left: KEY_GAP / 2,
  right: KEY_GAP / 2
} as const

const key = {
  height: KEY_HEIGHT,
  minWidth: 34,
  paddingHorizontal: 9,
  borderRadius: KEY_RADIUS,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5
} as const

export const terminalDockStyles = themedStyleSheet(() => ({
  dock: {
    zIndex: 20,
    backgroundColor: colors.bgPanel
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  liveField: {
    flex: 1,
    minWidth: 0
  },
  keyRow: {
    height: KEY_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: KEY_GAP,
    paddingHorizontal: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  keyScroll: {
    flex: 1,
    minWidth: 0
  },
  keyScrollContent: {
    alignItems: 'center',
    gap: KEY_GAP,
    paddingVertical: (KEY_ROW_HEIGHT - KEY_HEIGHT) / 2
  },
  key: {
    ...key,
    backgroundColor: colors.bgRaised
  },
  // The user's own keys from Settings, told apart from the built-in ones.
  customKey: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder
  },
  keyText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '500',
    fontFamily: typography.monoFamily
  },
  keyPressed: {
    opacity: feedback.pressedOpacity
  },
  // A Shift, Ctrl or Alt latch armed for the next key, and one locked on (the Duo rail's look).
  // A border on every latch, so arming one doesn't widen it.
  keyLatch: {
    borderWidth: 1,
    borderColor: 'transparent'
  },
  keyLatched: {
    borderColor: colors.textPrimary
  },
  keyLocked: {
    backgroundColor: colors.textPrimary
  },
  keyTextLocked: {
    color: colors.bgBase
  },
  smartGroup: {
    height: KEY_HEIGHT + SMART_GROUP_INSET * 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SMART_GROUP_INSET,
    paddingLeft: spacing.sm,
    paddingRight: SMART_GROUP_INSET,
    borderRadius: KEY_RADIUS + SMART_GROUP_INSET,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
    backgroundColor: colors.composerSurface
  },
  smartDivider: {
    width: StyleSheet.hairlineWidth,
    height: KEY_HEIGHT - spacing.sm,
    backgroundColor: colors.translucentFill
  },
  smartKeyStack: {
    alignItems: 'center'
  },
  smartKeyWord: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  smartKeyCombo: {
    color: colors.textSecondary,
    fontSize: 10,
    fontFamily: typography.monoFamily
  },
  // The prompt's accept key, in the app's filled primary.
  smartKeyPrimary: {
    backgroundColor: colors.surfaceBright
  },
  smartKeyPrimaryText: {
    color: colors.bgBase
  },
  ghostKey: {
    ...key,
    backgroundColor: 'transparent'
  },
  ghostKeyText: {
    color: colors.textSecondary
  },
  disabled: {
    opacity: feedback.disabledOpacity
  },
  sheetContent: {
    gap: spacing.md,
    paddingBottom: spacing.lg
  },
  sheetActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm
  },
  sheetAction: {
    ...key,
    height: 38,
    paddingHorizontal: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
    backgroundColor: colors.composerSurface
  },
  sheetActionText: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '500'
  },
  sheetKey: {
    backgroundColor: colors.sheetGroup
  },
  sheetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: KEY_GAP
  },
  sheetEmpty: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  }
}))
