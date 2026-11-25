import { colors, radii, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { LIST_ROW_PADDING } from '../../../components/list/ListGroup'

export const newWorktreeFormStyles = themedStyleSheet(() => ({
  header: {
    marginTop: -spacing.xs
  },
  // About the loaded form's height, so the sheet slides up once instead of growing when projects arrive.
  formPlaceholder: {
    minHeight: 440
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 15
  },
  // A field's own label inside a section, lined up with the field's text.
  fieldLabel: {
    fontSize: 13,
    color: colors.textSecondary,
    paddingHorizontal: spacing.md,
    marginBottom: 6
  },
  options: {
    gap: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs
  },
  repoDot: {
    width: 10,
    height: 10,
    borderRadius: radii.pill
  },
  disabled: {
    opacity: 0.55
  },
  // The SSH notice sits between the Where group and Start from, labelled like a section.
  field: {
    marginTop: spacing.lg
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
    paddingHorizontal: LIST_ROW_PADDING,
    marginBottom: 6
  },
  sshBox: {
    backgroundColor: colors.sheetGroup,
    borderRadius: radii.surface,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.md,
    gap: spacing.xs
  },
  sshRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md
  },
  sshDot: {
    width: 8,
    height: 8,
    borderRadius: radii.pill
  },
  sshDotConnected: {
    backgroundColor: colors.statusGreen
  },
  sshDotProgress: {
    backgroundColor: colors.statusAmber
  },
  sshDotDisconnected: {
    backgroundColor: colors.statusRed
  },
  sshCopy: {
    flex: 1,
    minWidth: 0
  },
  sshTitle: {
    fontSize: 15,
    color: colors.textPrimary,
    fontWeight: '500'
  },
  sshSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 1
  },
  sshConnectButton: {
    minHeight: 32,
    justifyContent: 'center',
    borderRadius: radii.control,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.md
  },
  sshConnectText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  },
  errorInline: {
    color: colors.statusRed,
    fontSize: 12
  },
  notice: {
    fontSize: 13,
    color: colors.statusAmber,
    paddingHorizontal: LIST_ROW_PADDING,
    marginTop: spacing.sm
  },
  error: {
    color: colors.statusRed,
    fontSize: 13,
    paddingHorizontal: LIST_ROW_PADDING,
    marginTop: spacing.lg
  },
  footer: {
    marginTop: spacing.xl
  },
  setupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    marginBottom: 6
  },
  setupLabel: {
    fontSize: 13,
    color: colors.textSecondary
  },
  setupSource: {
    fontSize: 13,
    color: colors.textMuted
  }
}))
