import { colors, feedback, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { LIST_LEADING_INSET, LIST_ROW_PADDING } from '../../../components/list/ListGroup'

const DOT = 8
const RING = 10

export const mcpPanelStyles = themedStyleSheet(() => ({
  sheet: {
    paddingBottom: spacing.xs
  },
  header: {
    marginTop: -spacing.xs
  },
  pageTop: {
    height: spacing.sm
  },
  loading: {
    paddingVertical: spacing.xl,
    alignItems: 'center'
  },
  notice: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.lg,
    gap: spacing.md,
    alignItems: 'flex-start'
  },
  noticeText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20
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
    fontSize: 13,
    color: colors.textSecondary
  },
  statusLineFailed: {
    color: colors.statusRed
  },
  accessory: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md
  },
  rowFailure: {
    color: colors.statusRed,
    fontSize: typography.metaSize,
    paddingLeft: LIST_LEADING_INSET,
    paddingRight: LIST_ROW_PADDING,
    paddingBottom: spacing.md,
    marginTop: -spacing.xs
  },
  signIn: {
    paddingLeft: LIST_LEADING_INSET,
    paddingRight: LIST_ROW_PADDING,
    paddingBottom: spacing.md,
    gap: spacing.sm
  },
  signInText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18
  },
  pasteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  pasteField: {
    flex: 1
  },
  signInActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
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
    fontSize: typography.bodySize,
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
