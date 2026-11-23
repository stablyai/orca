import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
export const groupStyles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  inset: { padding: spacing.md },
  picture: { alignItems: 'center', paddingTop: spacing.md },
  // The 96pt picture's slot with desktop's empty face: a 20/28 dashed circle in the middle.
  emptyPicture: {
    width: 68,
    height: 68,
    margin: 14,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.inputBorder,
    alignItems: 'center',
    justifyContent: 'center'
  },
  suggestion: { paddingTop: spacing.sm },
  members: { maxHeight: 256, paddingHorizontal: spacing.md, marginBottom: spacing.md },
  notice: { color: colors.textSecondary, fontSize: typography.metaSize, padding: spacing.md },
  turn: { paddingVertical: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  transcript: { paddingVertical: spacing.md },
  label: { color: colors.textSecondary, fontSize: typography.metaSize },
  grow: { flex: 1 },
  centered: { textAlign: 'center' }
}))
