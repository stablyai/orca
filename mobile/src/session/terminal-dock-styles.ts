import { StyleSheet } from 'react-native'
import { colors, feedback, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

const KEY_HEIGHT = 32
const KEY_ROW_HEIGHT = 46
const KEY_GAP = spacing.sm
const KEY_RADIUS = radii.control

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
  // Keys mode: the live field and its attach and mic buttons, on the composer's field shell.
  keysBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm
  },
  liveField: {
    flex: 1,
    minWidth: 0
  },
  composer: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm
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
  // Every key carries the one-shot outline's width so arming ctrl doesn't nudge the row.
  key: {
    ...key,
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: colors.bgRaised
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
  keyOnce: {
    borderColor: colors.accentBlue
  },
  keyOnceText: {
    color: colors.accentBlue
  },
  keyLocked: {
    backgroundColor: colors.accentBlue
  },
  keyLockedText: {
    color: colors.onAccent
  },
  ghostKey: {
    ...key,
    backgroundColor: 'transparent'
  },
  ghostKeyText: {
    color: colors.textSecondary
  },
  iconKey: {
    ...key,
    width: 34,
    paddingHorizontal: 0,
    backgroundColor: 'transparent'
  },
  modeKey: {
    ...key,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.composerBorder,
    backgroundColor: colors.composerSurface
  },
  modeKeyText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  disabled: {
    opacity: feedback.disabledOpacity
  },
  arrowPad: {
    width: 66,
    height: KEY_HEIGHT,
    borderRadius: radii.control,
    backgroundColor: colors.bgRaised
  },
  arrowPadDragging: {
    backgroundColor: colors.borderSubtle
  },
  arrowLeft: {
    position: 'absolute',
    left: 6,
    top: 10
  },
  arrowRight: {
    position: 'absolute',
    right: 6,
    top: 10
  },
  arrowUp: {
    position: 'absolute',
    left: 27.5,
    top: 2
  },
  arrowDown: {
    position: 'absolute',
    left: 27.5,
    bottom: 2
  },
  liveInputCapture: {
    position: 'absolute',
    opacity: 0,
    width: 1,
    height: 1,
    color: colors.textPrimary
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
