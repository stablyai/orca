import { StyleSheet } from 'react-native'
import { colors, feedback, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'

const DOT = 8
const RING = 10
const ROW_MIN_HEIGHT = 44
const CLOSE_SIZE = 32
/** Where a row's name starts, so the lines under it line up with the name. */
const NAME_INSET = spacing.md + RING + spacing.sm

export const mcpPanelStyles = themedStyleSheet(() => ({
  header: {
    minHeight: CLOSE_SIZE + spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    fontSize: typography.metaSize
  },
  title: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  summary: {
    color: colors.textMuted
  },
  summaryAttention: {
    color: colors.statusAmber
  },
  close: {
    width: CLOSE_SIZE,
    height: CLOSE_SIZE,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: {
    backgroundColor: colors.bgRaised
  },
  list: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.composerBorder
  },
  listContent: {
    paddingBottom: spacing.xs
  },
  groupLabel: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.composerBorder
  },
  noticeText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 17
  },
  row: {
    minHeight: ROW_MIN_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm
  },
  mark: {
    width: RING,
    alignItems: 'center'
  },
  name: {
    flexShrink: 1,
    maxWidth: '45%',
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: radii.pill
  },
  dotConnected: { backgroundColor: colors.statusGreen },
  dotNeedsAuth: { backgroundColor: colors.statusAmber },
  dotFailed: { backgroundColor: colors.statusRed },
  dotDisabled: { backgroundColor: colors.textMuted, opacity: 0.5 },
  // An open ring, as on desktop: the server is still connecting.
  dotPending: {
    width: RING,
    height: RING,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.textMuted,
    borderTopColor: 'transparent'
  },
  statusLine: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    color: colors.textMuted
  },
  statusLineFailed: {
    color: colors.statusRed
  },
  rowFailure: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    paddingLeft: NAME_INSET,
    paddingRight: spacing.md,
    paddingBottom: spacing.sm,
    marginTop: -spacing.xs
  },
  pasteBox: {
    paddingLeft: NAME_INSET,
    paddingRight: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.sm
  },
  pasteHint: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    lineHeight: 17
  },
  pasteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  pasteField: {
    flex: 1
  },
  button: {
    height: 32,
    minWidth: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonTall: {
    height: 44,
    paddingHorizontal: spacing.lg
  },
  buttonPrimary: {
    backgroundColor: colors.textPrimary
  },
  buttonSecondary: {
    backgroundColor: colors.translucentFill
  },
  buttonPlain: {
    paddingHorizontal: spacing.sm
  },
  buttonPressed: {
    opacity: feedback.pressedOpacity
  },
  buttonDisabled: {
    opacity: feedback.disabledOpacity
  },
  buttonLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary
  },
  buttonLabelPrimary: {
    color: colors.bgBase
  },
  buttonLabelPlain: {
    fontWeight: '500',
    color: colors.textSecondary
  },
  buttonLabelHidden: {
    opacity: 0
  },
  buttonSpinner: {
    position: 'absolute'
  }
}))
