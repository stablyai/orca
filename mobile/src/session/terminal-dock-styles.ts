import { StyleSheet } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'

const KEY_HEIGHT = 32
const KEY_RADIUS = 9

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
    gap: 2,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: 6
  },
  liveField: {
    flex: 1,
    minWidth: 0
  },
  composer: {
    marginHorizontal: spacing.sm,
    marginTop: spacing.sm,
    marginBottom: 6
  },
  keyRow: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  // The Duo's side rail is 84pt wide; keys span it less 4pt each side.
  keyRail: {
    flex: 1,
    minHeight: 0,
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs
  },
  keyScroll: {
    flex: 1,
    minWidth: 0
  },
  keyScrollVertical: {
    flex: 1,
    minHeight: 0
  },
  keyScrollContentVertical: {
    alignItems: 'stretch',
    gap: spacing.sm
  },
  keyVertical: {
    width: 'auto',
    height: 44,
    alignSelf: 'stretch',
    paddingHorizontal: 2
  },
  keyScrollContent: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7
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
    opacity: 0.7
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
    opacity: 0.35
  },
  arrowPad: {
    width: 66,
    height: KEY_HEIGHT,
    borderRadius: KEY_HEIGHT / 2,
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
  sheetHeading: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase'
  },
  sheetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6
  },
  sheetEmpty: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  }
}))
