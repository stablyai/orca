import { radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
export const groupStylesSheet = themedStyleSheet((colors) => ({
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
  members: { paddingHorizontal: spacing.md, marginBottom: spacing.md },
  footer: { marginTop: spacing.sm, paddingHorizontal: spacing.lg },
  notice: { color: colors.textSecondary, fontSize: typography.metaSize, padding: spacing.md },
  turn: { paddingVertical: spacing.md },
  // A chat row's time line, its Reply in the copy button's 24pt box.
  turnMeta: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  // Under a reply it sits in the row's own bottom padding, right under the words as a chat's does.
  turnMetaUnderRow: { marginTop: -spacing.sm },
  metaButton: {
    width: 24,
    height: 24,
    marginLeft: -5,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control
  },
  turnNotice: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  metaPressed: { backgroundColor: colors.bgRaised },
  transcript: { paddingVertical: spacing.md },
  label: { color: colors.textSecondary, fontSize: typography.metaSize },
  grow: { flex: 1 },
  repliesSlot: { flex: 1, minWidth: 0, alignItems: 'flex-start' },
  centered: { textAlign: 'center' }
}))
