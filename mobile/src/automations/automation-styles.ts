import { themedStyleSheet } from '../theme/themed-styles'
import { TEXT_INPUT_FONT_SIZE } from '../platform/text-input-font-size'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const automationStyles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xl },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
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
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.control,
    color: colors.textPrimary,
    padding: spacing.md,
    fontSize: TEXT_INPUT_FONT_SIZE,
    minHeight: 44
  },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
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
  disabled: { opacity: 0.45 },
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
