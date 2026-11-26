import { themedStyleSheet } from '../theme/themed-styles'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input/text-input-font-size'
import { LIST_ROW_PADDING } from '../components/list/ListGroup'
import { colors, feedback, radii, spacing, typography } from '../theme/mobile-theme'

export const automationStyles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  // Inset like Source Control's switch under its bar.
  tabs: { marginHorizontal: spacing.md, marginTop: spacing.sm, backgroundColor: colors.bgPanel },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xl },
  // Settings-style pages: sections carry their own spacing, as SettingsScreen's do.
  grouped: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl
  },
  instructions: {
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 21,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.md
  },
  bottomBar: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: colors.bgBase
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  grow: { flex: 1, minWidth: 0 },
  stack: { gap: spacing.sm },
  card: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.surface,
    backgroundColor: colors.bgPanel,
    padding: spacing.lg,
    gap: spacing.md
  },
  title: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '600' },
  heading: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  text: { color: colors.textPrimary, fontSize: typography.bodySize, lineHeight: 21 },
  meta: { color: colors.textSecondary, fontSize: typography.metaSize, lineHeight: 18 },
  error: { color: colors.statusRed, fontSize: typography.bodySize, lineHeight: 21 },
  field: { gap: spacing.sm },
  input: {
    padding: spacing.md,
    fontSize: TEXT_INPUT_FONT_SIZE,
    minHeight: 44
  },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
  placeField: { marginTop: spacing.sm },
  button: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radii.control,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgRaised
  },
  primaryButton: { backgroundColor: colors.textPrimary },
  buttonText: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  primaryText: { color: colors.bgBase },
  destructiveText: { color: colors.statusRed },
  disabled: { opacity: feedback.disabledOpacity },
  output: {
    color: colors.textPrimary,
    backgroundColor: colors.editorSurface,
    padding: spacing.md,
    borderRadius: radii.surface,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: 19
  },
  empty: { paddingVertical: spacing.xl, gap: spacing.md, alignItems: 'center' },
  separator: { height: 1, backgroundColor: colors.borderSubtle }
}))
